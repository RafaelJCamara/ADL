Feature: Withdrawal limits

  The top-level scenario deliberately comes first, and the Rule second, because
  a Rule: block absorbs every scenario that follows it until the next Rule or
  end of file — indentation does not end it. A fixture written the other way
  round would silently put the "top-level" scenario inside the rule and stop
  exercising document-order numbering across nesting levels at all.

  Scenario: Withdrawing within the daily limit
    Given a daily limit of 500
    When the customer withdraws 200
    Then the withdrawal succeeds

  Rule: A withdrawal above the daily limit is refused

    Scenario: Withdrawing above the daily limit
      Given a daily limit of 500
      When the customer withdraws 900
      Then the withdrawal is refused

    Scenario: Withdrawing exactly the daily limit
      Given a daily limit of 500
      When the customer withdraws 500
      Then the withdrawal succeeds
