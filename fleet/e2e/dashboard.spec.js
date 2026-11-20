import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function login(page){
  await page.goto('/');
  await page.getByLabel('Пароль').fill('Fleet-local-demo-19');
  await page.getByRole('button',{name:'Увійти'}).click();
}

test('маркер з’являється для підставленої GPS-позиції, історія повторно читається з кешу',async({page},testInfo)=>{
  await page.route('**/api/v1/devices',route=>route.fulfill({json:[{
    id:'truck-07',name:'Тестовий Тягач',region:'west',route:'Рейс 42',status:'normal',
    fuelMinPercent:10,speedLimit:60,
    latest:{lat:{value:50.443,ts:1},lon:{value:30.525,ts:1},fuel:{value:43,ts:1},speed:{value:58,ts:1}},
  }]}));
  const requests=[];
  page.on('request',req=>{if(req.url().includes('/api/v1/telemetry?'))requests.push(req.url());});
  await login(page);
  await expect(page.getByTestId('vehicle-marker')).toBeVisible();
  await expect(page.locator('[data-gps]')).toHaveAttribute('data-gps','50.44300,30.52500');
  await expect(page.getByText('Завантаження історії…')).toHaveCount(0);
  await page.getByRole('button',{name:'Тиждень'}).click();
  await expect(page.getByText('Завантаження історії…')).toHaveCount(0);
  await page.getByRole('button',{name:'Доба'}).click();
  await expect(page.getByText('Завантаження історії…')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  await writeFile(testInfo.outputPath('history-network.json'),JSON.stringify({ranges:['day','week','day'],apiCalls:requests},null,2));
  await page.screenshot({path:testInfo.outputPath('gps-marker.png'),fullPage:true});
});

test('відмова backend показує повідомлення без необробленої помилки',async({page},testInfo)=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/v1/devices',route=>route.abort('failed'));
  await login(page);
  await expect(page.getByRole('alert',{name:''}).filter({hasText:'Втрачено зв’язок'})).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('backend-unavailable.png'),fullPage:true});
});
