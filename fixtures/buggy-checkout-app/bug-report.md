# Checkout ignores quantity

## Steps to reproduce

1. Open the checkout page.
2. Set **Quantity** to `2` for the Field Notebook.
3. Select **Complete checkout**.

## Expected behavior

The charged total is `$24.00` because two notebooks cost `$12.00` each.

## Actual behavior

The checkout confirms `Charged total: $12.00`.
