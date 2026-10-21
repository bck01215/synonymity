// Loads the Playwright provider's type augmentation, which adds `launch` to
// the browser instance options (the runtime passes them to playwright's
// launch(), e.g. `launch: { channel: 'chrome' }`).
import type {} from '@vitest/browser/providers/playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [
        {
          browser: 'chromium',
          // Use the system Google Chrome instead of a downloaded Chromium build.
          launch: { channel: 'chrome' },
        },
      ],
    },
    setupFiles: ['./test-setup.ts'],
  },
});
