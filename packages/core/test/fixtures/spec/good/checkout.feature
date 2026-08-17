Feature: Checkout

  A customer pays for the items already in their cart.

  Background:
    Given the cart contains at least one item

  Scenario: Paying with a valid card
    Given a card that has not expired
    When the customer confirms payment
    Then the order is marked paid
    And a receipt is emailed to the customer

  @slow
  Scenario: Paying with an expired card
    Given a card that expired last month
    When the customer confirms payment
    Then the payment is refused
    But the cart is left untouched
