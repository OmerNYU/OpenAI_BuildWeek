"use client";

import { useState } from "react";

const product = {
  name: "Field Notebook",
  price: 12
};

export default function CheckoutPage() {
  const [quantity, setQuantity] = useState(1);
  const [checkoutTotal, setCheckoutTotal] = useState<number | null>(null);

  function checkout() {
    // Intentional fixture bug: checkout ignores the selected quantity.
    setCheckoutTotal(product.price);
  }

  return (
    <main>
      <h1>Checkout</h1>
      <p>{product.name}</p>
      <p>${product.price.toFixed(2)} each</p>
      <label htmlFor="quantity">Quantity</label>
      <input
        id="quantity"
        min="1"
        name="quantity"
        onChange={(event) => setQuantity(Number(event.target.value))}
        type="number"
        value={quantity}
      />
      <button onClick={checkout} type="button">
        Complete checkout
      </button>
      {checkoutTotal !== null ? (
        <p role="status">Charged total: ${checkoutTotal.toFixed(2)}</p>
      ) : null}
    </main>
  );
}
