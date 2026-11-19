# crateline

Quotes for wholesale packaging orders.

```
node bin/quote.mjs orders/ORD-1175.json
node bin/quote.mjs orders/ORD-1175.json --json
node bin/quote.mjs some-order.json --catalog other-catalog.json
```

## Data

- `data/catalog.json`: every SKU with its name and price tiers. A tier is `{ "minQty", "unitCents" }`;
  tiers are listed from the smallest `minQty` up. A line is priced with the tier that has the largest
  `minQty` its own quantity reaches. Each line is priced on its own quantity: two lines for the same SKU
  going to different places are not added together.
- `orders/*.json`: an order is an id, a customer and lines of `{ "sku", "qty", "shipTo" }`.

All amounts are whole cents inside the program and are printed with two decimals.

## Layout

- `bin/quote.mjs`: the command line.
- `src/quote.mjs`: turns an order into priced lines and a total.
- `src/pricing.mjs`, `src/tiers.mjs`: unit prices.
- `src/catalog.mjs`: reads the catalog.
- `src/render.mjs`, `src/format.mjs`: the printed quote.
- `src/lib/`: small helpers shared by the rest.

## Tests

```
node --test
```
