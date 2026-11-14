export async function acceptGoogleConsentIfShown(page) {
  for (const name of [/accept all/i, /agree/i]) {
    const button = page.getByRole('button', { name }).first();
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click();
    await page.waitForTimeout(750);
    return true;
  }
  return false;
}
