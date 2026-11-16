Feature: Annotate a browser page
  With the browserAnnotations experiment on, a page shown inside the app has
  an Annotate button. Its tools select an element, mark a region or draw, and
  Attach puts the comment, the page's context and a screenshot after the
  thread's draft, sending nothing.

  Background:
    Given the app is connected to a runner with the demo threads

  # The Swift app annotates its embedded WKWebView, and its dump has no
  # Annotate button or tools to drive, so these run on the GPUI app only.
  @browser.annotate @browser-annotations @web-runtime @swift-pending
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

  @browser.annotate @browser-annotations @web-runtime @swift-pending
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

  @browser.annotate @browser-annotations @web-runtime @swift-pending
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

  @browser.annotate @browser-annotations @browserbear @windows-pending @panel.web @web-runtime @swift-pending
  Scenario: Open an agent's page inside Threadbear for annotation
    Given the web runtime is installed
    And BrowserBear has the panel's site open as "Panel home" for "Morning brief"
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    And I press "Open here to annotate" on "Panel home"
    Then the pane shows the panel's site with an Annotate button
    And nothing was opened outside the app

  @browser.annotate @browser-annotations @panel.web @web-runtime @swift-pending
  Scenario: Open a page directly without BrowserBear
    Given the web runtime is installed
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    Then the Browser pane says "Open a page above to view and annotate it here."
    When I open the panel's site from the Browser pane's address field
    Then the pane shows the panel's site with an Annotate button
    And nothing was opened outside the app

  @browser.annotate @web-runtime @swift-pending
  Scenario: With the experiment off a page has no Annotate button
    Given the web runtime is installed
    When I open the thread "Rebuild the three landing pages"
    And I open "mockups/drawn.html" in the thread's folder in the pane
    Then the local page in the pane is titled "Drawn mockup"
    And the pane's page has no Annotate button
