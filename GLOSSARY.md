# Fyrklövern migration

This context preserves Fyrklövern customer and order history when moving to Shopify.

## Language

**Historical order**:
A Fyrklövern order that was paid and fulfilled before migration and is retained as prior purchase history.

**Fyrklövern customer**:
A person or organization in the Fyrklövern customer export, whether or not they placed an imported order.

**Fyrklövern customer number**:
The source identifier for a customer record. Distinct numbers represent separate customers unless a reviewed identity mapping establishes otherwise.

**Potential duplicate**:
A customer record with a missing or repeated Fyrklövern customer number, or an order with identical repeated source lines, that needs review before import. Shared phone numbers alone do not indicate duplicate customers.
