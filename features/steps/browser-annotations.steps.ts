import { Given, When, Then } from '@cucumber/cucumber';

// Browser input has a real Chrome/CDP test in app/Tools/browser-annotation-test.mjs.
// These cross-app scenarios stay pending until this driver owns a browser too.
Given('browser annotations are enabled and a local thread owns an agent browser page', () => 'pending');
When('I annotate an element and draw a mark on that page', () => 'pending');
When('I add a comment and switch to another thread before attaching', () => 'pending');
Then("the original thread's draft keeps its previous text and gains the comment and screenshot", () => 'pending');
Then('the annotation does not send a message automatically', () => 'pending');
When('I annotate an element and cancel', () => 'pending');
Then('the tools close and the existing draft is unchanged', () => 'pending');
