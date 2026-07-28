import { test, expect } from '@playwright/test';

test.describe('Core Volunteer Flow', () => {
  test('student applies, organizer approves, student verifies', async ({ page }) => {
    // 1. Navigate and Login as Student
    await page.goto('/');
    await page.fill('input[type="email"]', 'emiller2027@gmail.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/');
    
    // 2. Browse and find an event to apply for
    await page.click('text="Opportunities"');
    await expect(page.locator('.eventcard').first()).toBeVisible({ timeout: 15000 });
    
    // Open the Softball event
    await page.locator('.eventcard:has-text("Softball") .eventcard-foot button').first().click();
    await expect(page.locator('.modal-body')).toBeVisible();

    // 3. Select a shift and apply
    // We look for an enabled "Request" button on a shift slot
    const requestBtn = page.locator('button:has-text("Request"):not([disabled])').first();
    await requestBtn.click();
    
    // Now the "Send application" button should appear
    const sendAppBtn = page.getByRole('button', { name: /Send application/i });
    await expect(sendAppBtn).toBeVisible();
    await sendAppBtn.click();

    // Wait for the modal to update or just close it
    await page.waitForTimeout(1000);
    await page.click('.modal-close');
    
    // 4. Logout as student
    await page.locator('.userchip').click();
    await page.getByRole('menuitem', { name: /Sign out/i }).click();
    await expect(page).toHaveURL('/login');

    // 5. Login as Organizer
    await page.fill('input[type="email"]', 'jkatzenback@vikings.org');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    
    await expect(page).toHaveURL('/');

    // 6. Find event and approve
    const reviewBtn = page.getByRole('button', { name: /to review/i }).first();
    await expect(reviewBtn).toBeVisible({ timeout: 15000 });
    await reviewBtn.click();

    await expect(page.locator('.modal-body')).toBeVisible();

    // Switch to Applicants tab
    await page.getByRole('tab', { name: /Applicants/i }).click();
    
    // Look for Ethan Miller's pending application and approve it
    const approveBtn = page.getByRole('button', { name: 'Accept' }).first();
    await expect(approveBtn).toBeVisible({ timeout: 15000 });
    await approveBtn.click();
    await expect(page.getByText('Accepted').first()).toBeVisible();

    // Close modal and logout
    await page.click('.modal-close');
    await page.locator('.userchip').click();
    await page.getByRole('menuitem', { name: /Sign out/i }).click();

    // 7. Login as student again to verify
    await page.fill('input[type="email"]', 'emiller2027@gmail.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    
    // Check notifications
    await page.locator('.userchip').click();
    await page.getByText('Notifications', { exact: true }).first().click();
    await expect(page.locator('h1')).toContainText('Notifications');
    await expect(page.locator('body')).toContainText(/accepted/i);
  });
});
