Feature: The dark look
  In the dark, panels are black, the two icon rails a step lighter, the
  accent cyan and whatever needs you or is running yellow. The light look
  keeps the system's colours.

  Background:
    Given the app is connected to a runner with the demo threads

  # The Swift app has no command that reports its colours.
  @foundation.theme @swift-pending
  Scenario: Dark panels are black with lighter rails
    When I switch the app to the dark look
    Then the panels are "#000000"
    And the icon rails are "#1d1d1f"
    And diagrams are drawn on "#0b0b0b"

  @foundation.theme @swift-pending
  Scenario: The dark accent is cyan, with dark words on it
    When I switch the app to the dark look
    Then the accent is "#37ebf3"
    And links are "#37ebf3"
    And words on the accent are "#0d0f14"

  @foundation.theme @swift-pending
  Scenario: Needs you and anything running are yellow in the dark
    When I switch the app to the dark look
    Then Needs you is "#fdf500"
    And a running thread's spinner is "#fdf500"

  @foundation.theme @swift-pending
  Scenario: The light look keeps the system's colours
    When I switch the app to the light look
    Then the accent is not "#37ebf3"
    And Needs you is not "#fdf500"
    And the icon rails match the panels
