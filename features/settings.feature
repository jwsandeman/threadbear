Feature: Settings
  As someone who wants Threadbear set up my way
  I want the runner's settings in one window, each saying what it's for
  So I can change the few that matter here, and ask an agent for the rest

  Background:
    Given the app is connected to a runner with the demo threads

  @settings.general @project-decisions
  Scenario: Experiment changes reach an open project without reconnecting
    When I open the project "Threadbear"
    Then the project's decisions include "Rename the Settings tabs" asking "Call the Advanced tab \"Machine\" or \"Runner\"?"
    When the runner turns the "projectDecisions" experiment off
    Then the project's decisions don't include "Rename the Settings tabs"
    When the runner turns the "projectDecisions" experiment on
    Then the project's decisions include "Rename the Settings tabs" asking "Call the Advanced tab \"Machine\" or \"Runner\"?"

  # The Swift app's dump has no experiment switches to read, so these two
  # run on the GPUI app only.
  @settings.general @project-decisions @swift-pending
  Scenario: An experiment switch changes its feature once the runner confirms it
    When I open the project "Threadbear"
    And the runner holds settings changes
    And I open Settings
    And I press "Turn Project decisions off" in Settings
    Then Settings shows the "projectDecisions" experiment off
    And the project's decisions include "Rename the Settings tabs" asking "Call the Advanced tab \"Machine\" or \"Runner\"?"
    When the runner saves the settings changes it held
    Then the project's decisions don't include "Rename the Settings tabs"
    And Settings shows the "projectDecisions" experiment off

  @settings.general @project-decisions @swift-pending
  Scenario: A refused experiment switch leaves its feature on
    When I open the project "Threadbear"
    And the runner holds settings changes
    And I open Settings
    And I press "Turn Project decisions off" in Settings
    Then Settings shows the "projectDecisions" experiment off
    When the runner refuses the settings changes it held
    Then Settings says "Couldn't save the settings (disk full)."
    And Settings shows the "projectDecisions" experiment on
    And the project's decisions include "Rename the Settings tabs" asking "Call the Advanced tab \"Machine\" or \"Runner\"?"

  @settings.window
  Scenario: Settings opens on General, and another section can be picked
    When I open Settings
    Then Settings shows "general"
    When I open Settings on "models"
    Then Settings shows "models"

  # A scripted Swift app's arrow keys go only to a text box (`arrow`), so the
  # list's arrows are checked on the GPUI app.
  @settings.window @swift-pending
  Scenario: Up and down move through Settings' sections
    When I open Settings
    And I press the down arrow in Settings
    Then Settings shows "models"
    When I press the down arrow in Settings
    Then Settings shows "pools"
    When I press the up arrow in Settings
    Then Settings shows "models"

  # The Swift app's Settings is an AppKit form: a scripted click on one of its
  # controls starts a tracking loop that waits for a real mouse-up, so the
  # command never answers. Those scenarios are driven on the GPUI app only.
  @settings.general @swift-pending
  Scenario: Turning off Keep the Mac awake changes the runner's setting
    When I open Settings
    Then Settings says the Mac is kept awake
    When I press "Stop your Mac sleeping on its own while a thread is working" in Settings
    Then Settings says the Mac isn't kept awake

  # The Swift app is frozen, so it never gets this switch (AGENTS.md).
  @settings.general @swift-pending
  Scenario: Turning on full sync changes the runner's setting
    When I open Settings
    Then Settings says full sync is off
    When I press "Send tool output and diffs to your Convex deployment" in Settings
    Then Settings says full sync is on

  @settings.models @swift-pending
  Scenario: A private folder can be taken off
    When I open Settings on "models"
    Then Settings lists the private folder "~/dev/clients/acme"
    When I press "Stop keeping this folder private" in Settings
    Then Settings lists no private folders

  @settings.general @swift-pending
  Scenario: A reviewer can be taken off the list of who reviews code
    When I open Settings
    Then Settings lists the reviewers "codex, claude"
    When I press "Take Codex off the list" in Settings
    Then Settings lists the reviewers "claude"
