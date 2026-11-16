Feature: Annotate a browser page
  # The Swift app annotates its embedded WKWebView. These scenarios remain
  # manual until the cross-app driver can exercise that page's controls.

  @manual @gpui-pending @browser.annotate
  Scenario: Attach a requested change to its original thread
    Given browser annotations are enabled and a local thread displays a page inside Threadbear
    When I annotate an element and draw a mark on that page
    And I add a comment and attach it
    Then the original thread's draft keeps its previous text and pictures and gains the comment and screenshot
    And the annotation does not send a message automatically
    And no external browser opens

  @manual @gpui-pending @browser.annotate
  Scenario: Cancel without changing the page or draft
    Given browser annotations are enabled and a local thread displays a page inside Threadbear
    When I annotate an element and cancel
    Then the tools close and the existing draft is unchanged

  @manual @gpui-pending @browser.annotate
  Scenario: Leave the page before attaching
    Given I am annotating a page inside a local thread
    When I switch to another thread before attaching
    Then the unfinished annotation is cancelled
    And neither thread's draft changes

  @manual @gpui-pending @browser.annotate
  Scenario: Open an agent's page inside Threadbear for annotation
    Given browser annotations are enabled and a local thread lists an agent browser page
    When I choose Open here to annotate
    Then the page address opens inside Threadbear with an Annotate button
    And no external browser opens

  @manual @gpui-pending @browser.annotate
  Scenario: Open a page directly without BrowserBear
    Given browser annotations are enabled in a local thread and BrowserBear is stopped
    When I enter a page address in the Browser panel
    Then the page opens inside Threadbear with an Annotate button
    And no external browser opens
