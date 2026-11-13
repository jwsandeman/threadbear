Feature: Annotate a browser page
  # Browser pointer input runs in app/Tools/browser-annotation-test.mjs;
  # the cross-app driver does not yet control a separate browser.

  @manual @gpui-pending @browser.annotate
  Scenario: Attach a requested change to its original thread
    Given browser annotations are enabled and a local thread owns an agent browser page
    When I annotate an element and draw a mark on that page
    And I add a comment and switch to another thread before attaching
    Then the original thread's draft keeps its previous text and gains the comment and screenshot
    And the annotation does not send a message automatically

  @manual @gpui-pending @browser.annotate
  Scenario: Cancel without changing the page or draft
    Given browser annotations are enabled and a local thread owns an agent browser page
    When I annotate an element and cancel
    Then the tools close and the existing draft is unchanged
