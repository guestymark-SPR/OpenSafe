'use strict';
// Order emails: shop, order number, total and the things bought.
const test = require('node:test');
const assert = require('node:assert');
const { parse, shopFrom } = require('../src/orderinfo');

test('a typical layout: name, then price on the next line; totals left out', () => {
  const t = `Hello Mark,
Thanks for your order. We'll let you know when it's dispatched.
Order #204-1234567-8901234
Placed on 12 November 2026
Bosch PSB 1800 LI-2 Cordless Combi Drill
Qty: 1
£79.99
Anker USB-C Charger 65W
Qty: 2
£25.98
Item subtotal: £105.97
Delivery: £0.00
Order Total: £105.97`;
  const r = parse(t, { from: 'Amazon.co.uk <auto-confirm@amazon.co.uk>', subject: 'Your Amazon.co.uk order #204-1234567-8901234', date: '2026-11-12' });
  assert.strictEqual(r.isOrder, true);
  assert.strictEqual(r.shop, 'Amazon');
  assert.strictEqual(r.orderNo, '204-1234567-8901234');
  assert.strictEqual(r.total, 105.97);
  assert.deepStrictEqual(r.lines, [{ name: 'Bosch PSB 1800 LI-2 Cordless Combi Drill', price: 79.99, qty: 1 }, { name: 'Anker USB-C Charger 65W', price: 25.98, qty: 2 }]);
});

test('name and price on one line; shop from the email address', () => {
  const t = `Order confirmation
Order number: CW123456
1 x Samsung 55" QLED TV QE55Q60D - £549.00
1 x Wall bracket £29.99
Subtotal £578.99
VAT included £96.50
Total paid £578.99`;
  const r = parse(t, { from: 'orders@currys.co.uk', subject: 'Order confirmation' });
  assert.strictEqual(r.shop, 'Currys');
  assert.strictEqual(r.orderNo, 'CW123456');
  assert.strictEqual(r.total, 578.99);
  assert.deepStrictEqual(r.lines.map(x => [x.name, x.price]), [['Samsung 55" QLED TV QE55Q60D', 549], ['Wall bracket', 29.99]]);
});

test('not an order: no prices, or not about an order', () => {
  assert.strictEqual(parse('Dear Mark, see you Tuesday.', { subject: 'Meeting' }).isOrder, false);
  assert.strictEqual(parse('Your order has shipped', { subject: 'Shipped' }).isOrder, false);
  assert.strictEqual(shopFrom('"Screwfix" <noreply@screwfix.com>'), 'Screwfix');
  assert.strictEqual(shopFrom('noreply@e.argos.co.uk'), 'Argos');
});
