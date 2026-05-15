# WhatsApp Bot

This folder contains the production bot implementation from the V4 plan:

- Express webhook server for WhatsApp Cloud API
- Supabase-backed business config, KB search, conversations, images, and balance deduction
- OpenRouter response generation with exact token-cost deduction
- Hugging Face embeddings for vector search
- Top 10 KB retrieval by default
- Relevant image sending only when the image overlaps with both the customer query and matched knowledge

## Commands

```bash
npm install
npm start
```

Embed any pending KB entries:

```bash
npm run embed:kb
```

Create a business row by editing the config object inside `scripts/createBusiness.js`, then run:

```bash
node scripts/createBusiness.js
```

The business email is stored on the `businesses` row as `owner_email`, and the script also stores `owner_id` when the matching Supabase Auth user already exists.

Run syntax checks:

```bash
npm run check
```

## Required setup

1. Fill out `.env` with your business-specific and shared credentials.
2. Run the SQL in `database/schema.sql` on Supabase.
3. Insert a `businesses` row and set `BUSINESS_ID` in `.env`.
4. Add KB rows and run `npm run embed:kb` if you are not embedding them elsewhere.
5. Set the Meta webhook URL to `/webhook` and use `WHATSAPP_VERIFY_TOKEN`.
