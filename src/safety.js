export function classifyGoogleSafetyState(snapshot, { requireSignIn = true } = {}) {
  const text = snapshot?.bodyText || '';
  if (/unusual traffic from your computer network|automated queries|our systems have detected unusual traffic/i.test(text)) {
    return safetyIssue('unusual_traffic', 'Google reported unusual or automated traffic.');
  }
  if (snapshot?.hasCaptcha || /verify you(?:'re| are) not a robot|complete the captcha|recaptcha/i.test(text)) {
    return safetyIssue('captcha', 'Google requested CAPTCHA verification.');
  }
  if (requireSignIn && snapshot?.signInVisible && !snapshot?.accountVisible) {
    return safetyIssue('signed_out', 'The dedicated Google Maps profile is signed out.');
  }
  return null;
}

export function isSuspiciousEmptyMenu(menuScrape) {
  return menuScrape?.status === 'none'
    && menuScrape.tabExists === true
    && menuScrape.itemCount === 0;
}

function safetyIssue(code, message) {
  return { code, message };
}
