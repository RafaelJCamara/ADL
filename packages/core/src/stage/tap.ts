/**
 * A TAP report, read (ROLE-08, M08 step 8.5).
 *
 * TAP 13 and 14 as node's test runner (`--test-reporter=tap`) and vitest
 * (`--reporter=tap`) print them, hand-written and line-based: `@adl/core` stays
 * dependency-free but for Zod, and convention 17's supply-chain gate is not a
 * step-sized decision. It reads; it judges nothing — `runner-report.ts`'s
 * `judgeRunnerReport` does that.
 *
 * ## The rules, and the measurement behind each
 *
 * Every rule below was set against the installed runners' real output (the
 * fixtures under `test/fixtures/runner-report/` are that output, verbatim), not
 * against the TAP specification's prose alone.
 *
 * | Topic | Rule | Why |
 * |---|---|---|
 * | Document | The first column-0 `TAP version 13` or `TAP version 14` line opens it; **everything before it is ignored**. No such line is `no_document`. | npm prints `> pkg@1.0.0 test` before any runner output, and a runner told to print its `spec` reporter prints no version line — which must fail loudly, not read as an empty pass. |
 * | One document | A second column-0 `TAP version` line is `multiple_documents`. | A vitest test that writes a whole forged report to stdout puts it **before** the real one; two runners chained in one `npm test` do the same. Neither is one report. |
 * | Line classes | Plans, test points, `Bail out!` and `}` are structural. Comments (`# …`), blank lines and anything else are ignored. | node wraps a test's own console output as `# …` comments, and prints `# tests / # pass / # fail` summaries — which say **`# fail 0` beside a failed hook**, so they are never read. |
 * | Point | `ok` or `not ok`, then only a number, a `-` and a description, each after whitespace — the whole line is anchored. | `ok, starting server` and `okay` are noise, not tests: nothing may touch the status word. |
 * | Numbers | Parsed, **never validated**. | node reports `ok 1`, `ok 2`, then `not ok 1` under `1..3` when a test sets `process.exitCode`. |
 * | Name | A trailing ` {` is stripped first (it opens a buffered block), then the text splits at the first unescaped `#`: before it is the name, with `\#` and `\\` unescaped; after it, a segment beginning `skip` or `todo` is the directive and every other segment — vitest's `time=1.83ms` — is dropped. | vitest prints `ok 1 - a.test.mjs # SKIP {`. node escapes `#` in a name, so `not ok 1 - fails \# TODO y` is a failure and not a todo. |
 * | Status | `ok` passed · `not ok` failed · `# SKIP` skipped · `# TODO` todo · **`not ok # SKIP` failed**. | The last is fail-safe: neither runner prints it, and a failure that claims to be skipped is still a failure. |
 * | YAML | A `---` after a point (or after the `}` closing a buffered one), with nothing between but comments indented deeper than the point, and itself indented deeper, opens the point's diagnostic; it runs to `...` at the opener's own indent and is kept verbatim. Any other `---` is `malformed`. | node indents the block **+2**, vitest **+4**; vitest puts a test's `annotate()` notes as comments between. A stack trace containing `not ok 1` is just text inside the block. A `{` point whose YAML follows at once was a node test **named** with a trailing ` {` — a real buffered block opens with its plan — so it is a leaf and keeps the brace. |
 * | Nesting | A point ending ` {` owns the block one level deeper, closed by `}` at its own depth (TAP 14, vitest). Points and a plan one or more levels deeper with no owner are **adopted** by the next point at the level above (TAP 13 plus comments, node — whose children come before their parent, and may start two levels down). | One rule, no dialect detection. An orphaned deeper block, a dedent out of a `{` block without its `}`, or a `}` with no block is `malformed`. |
 * | Plans | Every block — the report and each subtest block — has exactly one plan, before its first point or after its last. Fewer points than planned, or no plan, is `truncated`; more, a second plan, or a point after a trailing plan, is `malformed`. `1..0` is a complete empty block. | A report that does not account for its own tests did not finish. |
 * | `Bail out!` | Ends the document at any depth; plan checks are waived and every point read so far is kept. | The one early stop a runner declares. |
 * | End | An open YAML block, an open `{` block or an orphaned node block is `truncated`. | |
 *
 * ## The one YAML key read, and why reading it can only make a judgement stricter
 *
 * node's diagnostic block carries `type: 'suite'` on a `describe`. An **empty**
 * `describe` prints no subtest block at all — structurally it is a passing leaf,
 * so without this key a tester that wrote only `describe('AC-1', () => {})`
 * would have "executed one test". **This closes the hole for node only.** vitest
 * run with `passWithNoTests` prints an empty `describe`, and a test-less file, as
 * plain passing leaves with no diagnostic at all — nothing a reader can tell from a
 * real test without guessing from names; `runner-report.ts` states it as a
 * residual, and step 8.8's must-fail-at-base guardrail is what catches it. So a point whose block has a top-level
 * `type: 'suite'` line is a group. That key can only turn a leaf into a group,
 * and a group is never counted as executed while a failed group is still a
 * failure — so it can move a judgement toward `inconclusive` or `send_back`,
 * never toward `pass`. Nothing else in a diagnostic is interpreted.
 */
import type {
  ReportedTest,
  ReportedTestStatus,
  RunnerReportDefect,
  RunnerReportRead,
} from './runner-report.js';

const VERSION_LINE = /^TAP version (\d+)\s*$/;
const PLAN_LINE = /^1\.\.(\d+)(?:\s*#\s*(.*))?$/;
const OTHER_PLAN_LINE = /^\d+\.\.\d+/;
const POINT_LINE = /^(not ok|ok)(?:\s+(\d+))?(?:\s+-)?(?:\s+(.*))?$/;
const BAIL_LINE = /^Bail out!\s*(.*)$/;
const DIRECTIVE = /^\s*(skip|todo)\S*(?:\s+([\s\S]*))?$/i;
const SUITE_TYPE_KEY = /^type:\s*['"]?suite['"]?\s*$/;
const INDENT_WIDTH = 4;

/** A point under construction. `children` is set when it owns or adopts a block. */
interface PointBuilder {
  name: string;
  /** For a point read as a `{` opener: its name with the trailing ` {` kept, in case it was a name. */
  braceName?: string;
  readonly status: ReportedTestStatus;
  readonly line: number;
  readonly indent: number;
  diagnostic?: string;
  children?: PointBuilder[];
  declaredSuite?: boolean;
}

interface Plan {
  readonly count: number;
  /** How many points preceded it — 0 for a leading plan. */
  readonly pointsBefore: number;
  readonly line: number;
  readonly comment?: string;
}

interface Frame {
  readonly depth: number;
  /** `root` holds the report's top level; `owned` belongs to a `{` point; `unowned` waits to be adopted. */
  readonly kind: 'root' | 'owned' | 'unowned';
  readonly owner?: PointBuilder;
  readonly points: PointBuilder[];
  plan?: Plan;
}

interface OpenYaml {
  readonly indent: number;
  readonly owner: PointBuilder;
  readonly lines: string[];
  readonly line: number;
}

type Defect = Extract<RunnerReportRead, { ok: false }>;

function defect(
  kind: RunnerReportDefect,
  detail: string,
  line?: number,
): Defect {
  return {
    ok: false,
    defect: kind,
    detail,
    ...(line === undefined ? {} : { line }),
  };
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/** Split `text` at every `#` not preceded by an escaping backslash. */
function splitUnescapedHashes(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === '#') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** `\#` → `#` and `\\` → `\`; any other backslash is kept as it was printed. */
function unescapeName(text: string): string {
  return text.replace(/\\([\\#])/g, '$1');
}

interface Description {
  readonly name: string;
  /** The name as it reads if the trailing ` {` is part of it rather than an opener. */
  readonly braceName?: string;
  readonly directive?: 'skip' | 'todo';
  readonly buffered: boolean;
}

function parseDescription(rest: string | undefined): Description {
  let text = rest ?? '';
  let buffered = false;
  let braceName: string | undefined;
  if (/(^|\s)\{$/.test(text)) {
    buffered = true;
    braceName = unescapeName(splitUnescapedHashes(text)[0] ?? '').trim();
    text = text.replace(/\s*\{$/, '');
  }
  const [namePart = '', ...tail] = splitUnescapedHashes(text);
  let directive: 'skip' | 'todo' | undefined;
  for (const segment of tail) {
    const match = DIRECTIVE.exec(segment);
    if (match !== null) {
      directive = match[1]!.toLowerCase() === 'skip' ? 'skip' : 'todo';
      break;
    }
  }
  const name = unescapeName(namePart).trim();
  return {
    name: name === '' ? '(unnamed)' : name,
    buffered,
    ...(braceName === undefined || braceName === '' ? {} : { braceName }),
    ...(directive === undefined ? {} : { directive }),
  };
}

function statusOf(ok: boolean, directive: 'skip' | 'todo' | undefined) {
  if (directive === 'todo') return 'todo' as const;
  if (directive === 'skip')
    return ok ? ('skipped' as const) : ('failed' as const);
  return ok ? ('passed' as const) : ('failed' as const);
}

/** A block is complete when its plan accounts for exactly its points. */
function closeFrame(frame: Frame, where: string): Defect | undefined {
  const { plan } = frame;
  if (plan === undefined) {
    return defect('truncated', `${where} has no plan`);
  }
  if (frame.points.length < plan.count) {
    return defect(
      'truncated',
      `${where} planned ${String(plan.count)} tests and reported ${String(frame.points.length)}`,
      plan.line,
    );
  }
  if (frame.points.length > plan.count) {
    return defect(
      'malformed',
      `${where} planned ${String(plan.count)} tests and reported ${String(frame.points.length)}`,
      plan.line,
    );
  }
  return undefined;
}

function whereOf(frame: Frame): string {
  return frame.owner === undefined
    ? 'the report'
    : `the subtests of "${frame.owner.name}"`;
}

function finish(point: PointBuilder): ReportedTest {
  const children =
    point.children ?? (point.declaredSuite === true ? [] : undefined);
  return {
    name: point.name,
    status: point.status,
    line: point.line,
    ...(point.diagnostic === undefined ? {} : { diagnostic: point.diagnostic }),
    ...(children === undefined ? {} : { children: children.map(finish) }),
  };
}

function attachYaml(yaml: OpenYaml): void {
  const dedented = yaml.lines.map((line) => {
    const drop = Math.min(leadingSpaces(line), yaml.indent);
    return line.slice(drop);
  });
  yaml.owner.diagnostic = dedented.join('\n');
  if (dedented.some((line) => SUITE_TYPE_KEY.test(line))) {
    yaml.owner.declaredSuite = true;
  }
}

/** Read `text` as one TAP report. Never throws. */
export function readTapReport(text: string): RunnerReportRead {
  const lines = text.split('\n');
  let started = false;
  const root: Frame = { depth: 0, kind: 'root', points: [] };
  const stack: Frame[] = [root];
  let yaml: OpenYaml | undefined;
  // The point a YAML block on the very next line would belong to.
  let attachable: PointBuilder | undefined;
  let bailOut: { reason: string; line: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const raw = lines[index]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (!started) {
      const version = VERSION_LINE.exec(line);
      if (version === null) continue;
      if (version[1] !== '13' && version[1] !== '14') {
        return defect(
          'malformed',
          `TAP version ${version[1]!} is not one ADL reads (13 or 14)`,
          lineNo,
        );
      }
      started = true;
      continue;
    }

    if (yaml !== undefined) {
      if (
        leadingSpaces(line) === yaml.indent &&
        line.slice(yaml.indent).trimEnd() === '...'
      ) {
        attachYaml(yaml);
        yaml = undefined;
        attachable = undefined;
        continue;
      }
      yaml.lines.push(line);
      continue;
    }

    if (VERSION_LINE.test(line)) {
      return defect(
        'multiple_documents',
        'a second TAP document began; a gate reports one run',
        lineNo,
      );
    }

    const indent = leadingSpaces(line);
    const content = line.slice(indent).trimEnd();
    // vitest prints a test's `annotate()` notes as `# type: message` comments
    // BETWEEN its point and its YAML block, indented deeper than the point —
    // found by step 8.5's review against vitest 4.1. Such a comment keeps the
    // point attachable; anything else ends its chance of a diagnostic.
    if (
      attachable !== undefined &&
      content.startsWith('#') &&
      indent > attachable.indent
    ) {
      continue;
    }
    const yamlOwner = attachable;
    attachable = undefined;

    if (content === '---') {
      if (yamlOwner !== undefined && indent > yamlOwner.indent) {
        // A point read as a `{` opener whose YAML follows at once was never an
        // opener: a real buffered block opens with its plan, and a YAML block
        // comes after its `}`. node escapes `#` in a name but not `{`, and
        // prints YAML after every point — so a node test NAMED `returns {` lands
        // here, and is a leaf with its brace back on its name.
        const top = stack[stack.length - 1]!;
        if (
          top.kind === 'owned' &&
          top.owner === yamlOwner &&
          top.points.length === 0 &&
          top.plan === undefined
        ) {
          stack.pop();
          delete yamlOwner.children;
          if (yamlOwner.braceName !== undefined) {
            yamlOwner.name = yamlOwner.braceName;
          }
        }
        yaml = { indent, owner: yamlOwner, lines: [], line: lineNo };
        continue;
      }
      return defect(
        'malformed',
        'a YAML block that does not directly follow a test point',
        lineNo,
      );
    }

    const point = POINT_LINE.exec(content);
    const plan = point === null ? PLAN_LINE.exec(content) : null;
    const bail =
      point === null && plan === null ? BAIL_LINE.exec(content) : null;
    const close = content === '}';

    if (point === null && plan === null && bail === null && !close) {
      if (OTHER_PLAN_LINE.test(content)) {
        return defect(
          'malformed',
          `a plan must start at 1: ${content}`,
          lineNo,
        );
      }
      // A comment, a blank line, a pragma, or noise: none of it is judged.
      continue;
    }

    if (indent % INDENT_WIDTH !== 0) {
      return defect(
        'malformed',
        `a structural line indented by ${String(indent)} spaces, not a multiple of ${String(INDENT_WIDTH)}`,
        lineNo,
      );
    }
    const depth = indent / INDENT_WIDTH;

    if (bail !== null) {
      bailOut = { reason: bail[1]!.trim(), line: lineNo };
      break;
    }

    if (close) {
      const top = stack[stack.length - 1]!;
      if (top.kind !== 'owned' || top.depth !== depth + 1) {
        return defect(
          'malformed',
          'a `}` that closes no open subtest block',
          lineNo,
        );
      }
      const problem = closeFrame(top, whereOf(top));
      if (problem !== undefined) return problem;
      stack.pop();
      attachable = top.owner;
      continue;
    }

    // Align the stack with this line's depth.
    let top = stack[stack.length - 1]!;
    let adopt: Frame | undefined;
    if (depth > top.depth) {
      for (let d = top.depth + 1; d <= depth; d += 1) {
        stack.push({ depth: d, kind: 'unowned', points: [] });
      }
      top = stack[stack.length - 1]!;
    } else if (depth < top.depth) {
      if (top.depth > depth + 1) {
        return defect(
          'malformed',
          `subtests at depth ${String(top.depth)} were never claimed by a parent test point`,
          lineNo,
        );
      }
      if (top.kind === 'owned') {
        return defect(
          'malformed',
          `the subtests of "${top.owner!.name}" ended without their closing \`}\``,
          lineNo,
        );
      }
      if (point === null) {
        return defect(
          'malformed',
          'subtests with no parent test point before a plan',
          lineNo,
        );
      }
      adopt = top;
      stack.pop();
      top = stack[stack.length - 1]!;
    }

    if (plan !== null) {
      if (top.plan !== undefined) {
        return defect('malformed', `${whereOf(top)} has a second plan`, lineNo);
      }
      top.plan = {
        count: Number(plan[1]),
        pointsBefore: top.points.length,
        line: lineNo,
        ...(plan[2] === undefined ? {} : { comment: plan[2] }),
      };
      continue;
    }

    // A test point.
    if (top.plan !== undefined && top.plan.pointsBefore > 0) {
      return defect(
        'malformed',
        `a test point after ${whereOf(top)}'s trailing plan`,
        lineNo,
      );
    }
    const description = parseDescription(point![3]);
    const builder: PointBuilder = {
      name: description.name,
      status: statusOf(point![1] === 'ok', description.directive),
      line: lineNo,
      indent,
      ...(description.braceName === undefined
        ? {}
        : { braceName: description.braceName }),
    };
    if (adopt !== undefined) {
      if (description.buffered) {
        return defect(
          'malformed',
          'a test point that both adopts earlier subtests and opens a `{` block',
          lineNo,
        );
      }
      const problem = closeFrame(adopt, `the subtests of "${builder.name}"`);
      if (problem !== undefined) return problem;
      builder.children = adopt.points;
    }
    top.points.push(builder);
    if (description.buffered) {
      builder.children = [];
      stack.push({
        depth: depth + 1,
        kind: 'owned',
        owner: builder,
        points: builder.children,
      });
    }
    attachable = builder;
  }

  if (!started) {
    return defect(
      'no_document',
      'the output contains no `TAP version` line, so it is not a TAP report',
    );
  }

  if (bailOut !== undefined) {
    // The one declared early stop. Plans are waived; points in blocks nobody
    // claimed yet are kept at the level below rather than lost, because a
    // failure among them is still a failure.
    for (let i = stack.length - 1; i > 0; i -= 1) {
      const frame = stack[i]!;
      if (frame.kind === 'unowned') stack[i - 1]!.points.push(...frame.points);
    }
    return {
      ok: true,
      report: {
        format: 'tap',
        tests: root.points.map(finish),
        bailOut,
      },
    };
  }

  if (yaml !== undefined) {
    return defect(
      'truncated',
      'the report ended inside a YAML diagnostic block',
      yaml.line,
    );
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1]!;
    return defect(
      'truncated',
      top.kind === 'owned'
        ? `the report ended inside the subtests of "${top.owner!.name}"`
        : 'the report ended with subtests no parent test point claimed',
    );
  }
  const problem = closeFrame(root, 'the report');
  if (problem !== undefined) return problem;

  const skipAll =
    root.plan!.count === 0 && root.plan!.comment !== undefined
      ? DIRECTIVE.exec(root.plan!.comment)
      : null;

  return {
    ok: true,
    report: {
      format: 'tap',
      tests: root.points.map(finish),
      ...(skipAll !== null && skipAll[1]!.toLowerCase() === 'skip'
        ? { skipAll: (skipAll[2] ?? '').trim() }
        : {}),
    },
  };
}
