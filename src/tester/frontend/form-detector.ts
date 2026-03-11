import type { Page } from 'playwright';
import type { FormInfo, FormTestResult } from '../../types/index.js';
import type { NetworkMonitor } from './network-monitor.js';

export class FormDetector {
  async detectForms(page: Page): Promise<FormInfo[]> {
    try {
      return await page.$$eval('form', (forms) =>
        forms.map((form) => {
          const fields = Array.from(
            form.querySelectorAll('input, select, textarea'),
          ).map((el) => ({
            name: el.getAttribute('name') ?? '',
            type: el.getAttribute('type') ?? el.tagName.toLowerCase(),
            required: el.hasAttribute('required'),
            placeholder: el.getAttribute('placeholder') ?? undefined,
          }));

          return {
            action: form.getAttribute('action') ?? '',
            method: (form.getAttribute('method') ?? 'GET').toUpperCase(),
            fields,
          };
        }),
      );
    } catch {
      return [];
    }
  }

  async fillAndSubmit(
    page: Page,
    form: FormInfo,
    data: Record<string, string>,
    monitor?: NetworkMonitor,
  ): Promise<FormTestResult> {
    const validationErrors: string[] = [];
    const entriesBefore = monitor ? monitor.getEntries().length : 0;

    try {
      for (const field of form.fields) {
        const value = data[field.name];
        if (value === undefined) continue;
        const selector = `[name="${field.name}"]`;

        try {
          if (field.type === 'select') {
            await page.selectOption(selector, value);
          } else if (field.type === 'checkbox' || field.type === 'radio') {
            if (value === 'true' || value === 'on') {
              await page.check(selector);
            }
          } else {
            await page.fill(selector, value);
          }
        } catch (err) {
          validationErrors.push(
            `Failed to fill field "${field.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const submitBtn = await page.$(
        'form button[type="submit"], form input[type="submit"], form button:not([type])',
      );

      if (submitBtn) {
        await submitBtn.click();
      } else {
        validationErrors.push('No submit button found');
      }

      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      const entries = monitor ? monitor.getEntries() : [];
      const newEntries = entries.slice(entriesBefore);

      const networkRequest = newEntries.find((e) => e.type === 'request');
      const networkResponse = newEntries.find((e) => e.type === 'response');

      return {
        formInfo: form,
        dataSubmitted: data,
        networkRequest,
        networkResponse,
        validationErrors,
        passed: validationErrors.length === 0,
      };
    } catch (err) {
      validationErrors.push(
        `Form submission error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        formInfo: form,
        dataSubmitted: data,
        validationErrors,
        passed: false,
      };
    }
  }
}

export class AuthHandler {
  async detectLoginPage(page: Page): Promise<boolean> {
    try {
      const url = page.url().toLowerCase();
      if (/\/(login|signin|sign-in|auth)/.test(url)) return true;

      const hasPasswordField = await page.$('input[type="password"]');
      return hasPasswordField !== null;
    } catch {
      return false;
    }
  }

  async authenticate(
    page: Page,
    credentials: { username: string; password: string },
  ): Promise<boolean> {
    try {
      const urlBefore = page.url();

      const usernameSelector =
        'input[type="email"], input[name="email"], input[name="username"], input[type="text"][autocomplete="username"]';
      const passwordSelector = 'input[type="password"]';

      const usernameInput = await page.$(usernameSelector);
      const passwordInput = await page.$(passwordSelector);

      if (!usernameInput || !passwordInput) return false;

      await usernameInput.fill(credentials.username);
      await passwordInput.fill(credentials.password);

      const submitBtn = await page.$(
        'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")',
      );

      if (submitBtn) {
        await submitBtn.click();
      } else {
        await passwordInput.press('Enter');
      }

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      return page.url() !== urlBefore;
    } catch {
      return false;
    }
  }
}
