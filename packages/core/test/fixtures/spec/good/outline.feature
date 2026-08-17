Feature: Cart totals

  Scenario Outline: The cart total is the sum of its lines
    Given a cart holding <quantity> items priced at 10 each
    Then the cart total is <total>

    Examples:
      | quantity | total |
      | 1        | 10    |
      | 2        | 20    |
      | 3        | 30    |
