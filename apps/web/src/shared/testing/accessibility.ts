import axe from 'axe-core';

/**
 * Runs axe over a rendered subtree and returns the violations in a readable form.
 *
 * Automated checks find roughly a third of accessibility problems — they cannot tell
 * whether a label makes sense, or whether a table's structure matches the data it holds.
 * What they do catch is the mechanical third: a table without headers, a control without a
 * name, contrast below 4.5:1. Catching that third automatically leaves the review time for
 * the two thirds a person has to judge.
 */
export async function accessibilityViolations(container: HTMLElement): Promise<readonly string[]> {
  const results = await axe.run(container, {
    // Colour contrast needs real layout and painted pixels, which jsdom does not do; it
    // would report a false failure on every element. Contrast is checked in the design
    // tokens instead.
    rules: { 'color-contrast': { enabled: false } },
  });

  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${String(violation.nodes.length)} element(s))`,
  );
}
