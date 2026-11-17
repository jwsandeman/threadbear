Feature: Annotate a browser page
  A page shown inside the app for a local thread has an Annotate button
  without an experiment switch. Its tools select an element, mark a region or draw, and
  Attach puts the comment, the page's context and a screenshot after the
  thread's draft, sending nothing.

  Background:
    Given the app is connected to a runner with the demo threads

  # The Swift app annotates its embedded WKWebView, and its dump has no
  # Annotate button or tools to drive, so these run on the GPUI app only.
  @browser.annotate @web-runtime @swift-pending
  Scenario: Attach a requested change to its original thread
    Given the web runtime is installed
    When I open the thread "Rebuild the three landing pages"
    And I type "Before the annotation" in the composer
    And I open "mockups/drawn.html" in the thread's folder in the pane
    And I press Annotate over the page in the pane
    And I select the page's "p" with the annotation tools
    And I attach the annotation with the comment "Make this line bigger"
    Then the pane's annotation line says "Annotation attached to this thread's draft. Review it, then send."
    And the composer keeps "Before the annotation" and gains the comment "Make this line bigger"
    And the composer names the page "mockups/drawn.html" and its "p"
    And the composer has 1 picture
    And the annotation sent no message
    And nothing was opened outside the app

  @browser.annotate @web-runtime @swift-pending
  Scenario: Cancel without changing the page or draft
    Given the web runtime is installed
    When I open the thread "Rebuild the three landing pages"
    And I type "Before the annotation" in the composer
    And I open "mockups/drawn.html" in the thread's folder in the pane
    And I press Annotate over the page in the pane
    And I select the page's "p" with the annotation tools
    And I press Cancel annotation over the page in the pane
    Then the annotation tools are closed
    And the composer says only "Before the annotation"

  @browser.annotate @web-runtime @swift-pending
  Scenario: Leave the page before attaching
    Given the web runtime is installed
    When I open the thread "Rebuild the three landing pages"
    And I type "Before the annotation" in the composer
    And I open "mockups/drawn.html" in the thread's folder in the pane
    And I press Annotate over the page in the pane
    And I select the page's "p" with the annotation tools
    And I open the thread "Morning brief"
    Then no annotation is under way
    And the composer says only ""
    When I open the thread "Rebuild the three landing pages"
    Then the composer says only "Before the annotation"

  @browser.annotate @browserbear @windows-pending @panel.web @web-runtime @swift-pending
  Scenario: Open an agent's page inside Threadbear for annotation
    Given the web runtime is installed
    And BrowserBear has the panel's site open as "Panel home" for "Morning brief"
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    And I press "Open here to annotate" on "Panel home"
    Then the pane shows the panel's site with an Annotate button
    And nothing was opened outside the app

  @browser.annotate @panel.web @web-runtime @swift-pending
  Scenario: Open a page directly without BrowserBear
    Given the web runtime is installed
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    Then the Browser pane says "Open a page above to view and annotate it here."
    When I open the panel's site from the Browser pane's address field
    Then the pane shows the panel's site with an Annotate button
    And nothing was opened outside the app

  @browser.annotate @swift-pending
  Scenario: Annotations are standard and have no experiment switch
    When I open Settings
    Then Settings has no "browserAnnotations" experiment

  @browser.annotate @web-runtime @swift-pending
  Scenario: Cancel while the screenshot is being kept attaches nothing
    Given the web runtime is installed
    When I open the thread "Rebuild the three landing pages"
    And I type "Before the annotation" in the composer
    And I open "mockups/drawn.html" in the thread's folder in the pane
    And I press Annotate over the page in the pane
    And I select the page's "p" with the annotation tools
    And the runner holds the pictures it's given
    And I attach the annotation with the comment "Make this line bigger"
    Then the runner is holding the annotation's screenshot
    When I press Cancel annotation over the page in the pane
    And the runner keeps the pictures it held
    Then the annotation tools are closed
    And the composer still says only "Before the annotation"
