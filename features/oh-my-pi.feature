Feature: Oh My Pi beside the other agents
  A login for Oh My Pi that's in no pool still has its models in the
  picker, and a thread on it is never offered Plan first, which Oh My Pi
  doesn't have.

  Background:
    Given the app is connected to a runner with the demo threads
    And the runner has an Oh My Pi login outside every pool

  # Not run against the Swift app, which is frozen.
  @composer.modelpicker @swift-pending
  Scenario: Its models have a column of their own beside the pools
    When I open the thread "Add dark mode to the dashboard"
    Then the "model" menu has a row "# Oh My Pi"
    And the "model" menu has a row "[ ] Pi Large"

  @composer.modelpicker @composer.permission @swift-pending
  Scenario: A thread moved to it loses Plan first
    When I open the thread "Add dark mode to the dashboard"
    Then the "permission" menu has a row "[ ] Plan first"
    When I pick "Pi Large" from the "model" menu
    Then the model chip says "Oh My Pi · Pi Large"
    And the "permission" menu has no row "[ ] Plan first"
    And the "permission" menu has a row "[ ] Ask before edits"
