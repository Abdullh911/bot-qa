create extension if not exists vector;

create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id),
  owner_email text not null,
  name text not null,
  bot_name text default 'Assistant',
  bot_persona text default 'friendly and professional',
  fallback_msg text default 'Sorry, I did not understand. Please contact us directly.',
  language_hint text default 'auto',
  balance numeric(12, 8) not null default 0,
  low_balance_msg text default 'Service temporarily unavailable. Please try again later.',
  similarity_threshold numeric(3, 2) default 0.65,
  vector_top_k int default 10,
  created_at timestamptz default now()
);

alter table businesses add column if not exists owner_email text;

create unique index if not exists businesses_owner_email_lower_idx
  on businesses (lower(owner_email))
  where owner_email is not null;

create unique index if not exists businesses_owner_id_unique_idx
  on businesses (owner_id)
  where owner_id is not null;

create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  category text not null,
  title text not null,
  content text not null,
  embedding vector(1024),
  is_active boolean default true,
  embedded_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists knowledge_base_embedding_idx
  on knowledge_base
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists images (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  url text not null,
  description text not null,
  caption text,
  tags text[],
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_phone text not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now(),
  unique (business_id, customer_phone)
);

create table if not exists usage_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  customer_phone text not null,
  input_tokens int not null,
  output_tokens int not null,
  cost_usd numeric(12, 8) not null,
  balance_before numeric(12, 8) not null,
  balance_after numeric(12, 8) not null,
  created_at timestamptz default now()
);

create table if not exists processed_messages (
  message_id text primary key,
  processed_at timestamptz default now()
);

create or replace function search_knowledge_base(
  query_embedding vector(1024),
  business_id_input uuid,
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  category text,
  title text,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    kb.id,
    kb.category,
    kb.title,
    kb.content,
    1 - (kb.embedding <=> query_embedding) as similarity
  from knowledge_base kb
  where
    kb.business_id = business_id_input
    and kb.is_active = true
    and kb.embedding is not null
    and 1 - (kb.embedding <=> query_embedding) > match_threshold
  order by kb.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function deduct_balance(
  business_id_input uuid,
  cost_input numeric,
  input_tokens_in int,
  output_tokens_in int,
  customer_phone_in text
)
returns jsonb
language plpgsql
as $$
declare
  current_balance numeric;
  new_balance numeric;
begin
  select balance
  into current_balance
  from businesses
  where id = business_id_input
  for update;

  if current_balance is null then
    raise exception 'Business % not found', business_id_input;
  end if;

  if current_balance < cost_input then
    return jsonb_build_object(
      'success', false,
      'reason', 'insufficient_balance',
      'balance', current_balance
    );
  end if;

  new_balance := current_balance - cost_input;

  update businesses
  set balance = new_balance
  where id = business_id_input;

  insert into usage_log (
    business_id,
    customer_phone,
    input_tokens,
    output_tokens,
    cost_usd,
    balance_before,
    balance_after
  )
  values (
    business_id_input,
    customer_phone_in,
    input_tokens_in,
    output_tokens_in,
    cost_input,
    current_balance,
    new_balance
  );

  return jsonb_build_object(
    'success', true,
    'cost_usd', cost_input,
    'balance_before', current_balance,
    'balance_after', new_balance
  );
end;
$$;

create or replace function append_conversation_messages(
  business_id_input uuid,
  customer_phone_input text,
  messages_to_add_input jsonb,
  max_messages_input int
)
returns jsonb
language plpgsql
as $$
declare
  merged_messages jsonb;
begin
  insert into conversations (business_id, customer_phone, messages, updated_at)
  values (
    business_id_input,
    customer_phone_input,
    coalesce(messages_to_add_input, '[]'::jsonb),
    now()
  )
  on conflict (business_id, customer_phone)
  do update
  set
    messages = (
      with merged as (
        select value, ord
        from jsonb_array_elements(
          coalesce(conversations.messages, '[]'::jsonb) ||
          coalesce(excluded.messages, '[]'::jsonb)
        ) with ordinality as t(value, ord)
      ),
      trimmed as (
        select value, ord
        from merged
        order by ord desc
        limit greatest(max_messages_input, 1)
      )
      select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
      from trimmed
    ),
    updated_at = now()
  returning messages into merged_messages;

  return merged_messages;
end;
$$;

alter table businesses enable row level security;
alter table knowledge_base enable row level security;
alter table images enable row level security;
alter table conversations enable row level security;
alter table usage_log enable row level security;

create or replace function is_business_owner(target_business_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from businesses
    where
      id = target_business_id
      and (
        lower(owner_email) = lower(auth.jwt() ->> 'email')
        or owner_id = auth.uid()
      )
  );
$$;

drop policy if exists owner_only_businesses on businesses;
drop policy if exists owner_only_businesses_select on businesses;
drop policy if exists owner_only_businesses_update on businesses;
create policy owner_only_businesses_select on businesses
  for select using (
    lower(owner_email) = lower(auth.jwt() ->> 'email')
    or owner_id = auth.uid()
  );
create policy owner_only_businesses_update on businesses
  for update using (
    lower(owner_email) = lower(auth.jwt() ->> 'email')
    or owner_id = auth.uid()
  )
  with check (
    lower(owner_email) = lower(auth.jwt() ->> 'email')
    or owner_id = auth.uid()
  );

drop policy if exists owner_only_knowledge_base on knowledge_base;
drop policy if exists owner_only_knowledge_base_select on knowledge_base;
drop policy if exists owner_only_knowledge_base_insert on knowledge_base;
drop policy if exists owner_only_knowledge_base_update on knowledge_base;
drop policy if exists owner_only_knowledge_base_delete on knowledge_base;
create policy owner_only_knowledge_base_select on knowledge_base
  for select using (is_business_owner(business_id));
create policy owner_only_knowledge_base_insert on knowledge_base
  for insert with check (is_business_owner(business_id));
create policy owner_only_knowledge_base_update on knowledge_base
  for update using (is_business_owner(business_id))
  with check (is_business_owner(business_id));
create policy owner_only_knowledge_base_delete on knowledge_base
  for delete using (is_business_owner(business_id));

drop policy if exists owner_only_images on images;
drop policy if exists owner_only_images_select on images;
drop policy if exists owner_only_images_insert on images;
drop policy if exists owner_only_images_update on images;
drop policy if exists owner_only_images_delete on images;
create policy owner_only_images_select on images
  for select using (is_business_owner(business_id));
create policy owner_only_images_insert on images
  for insert with check (is_business_owner(business_id));
create policy owner_only_images_update on images
  for update using (is_business_owner(business_id))
  with check (is_business_owner(business_id));
create policy owner_only_images_delete on images
  for delete using (is_business_owner(business_id));

drop policy if exists owner_only_conversations on conversations;
drop policy if exists owner_only_conversations_select on conversations;
create policy owner_only_conversations_select on conversations
  for select using (is_business_owner(business_id));

drop policy if exists owner_only_usage_log on usage_log;
drop policy if exists owner_only_usage_log_select on usage_log;
create policy owner_only_usage_log_select on usage_log
  for select using (is_business_owner(business_id));

insert into storage.buckets (id, name, public)
values ('business-images', 'business-images', true)
on conflict (id) do nothing;

drop policy if exists business_images_public_read on storage.objects;
drop policy if exists business_images_owner_insert on storage.objects;
drop policy if exists business_images_owner_update on storage.objects;
drop policy if exists business_images_owner_delete on storage.objects;
create policy business_images_public_read on storage.objects
  for select using (bucket_id = 'business-images');
create policy business_images_owner_insert on storage.objects
  for insert with check (
    bucket_id = 'business-images'
    and split_part(name, '/', 1) in (
      select id::text
      from businesses
      where
        lower(owner_email) = lower(auth.jwt() ->> 'email')
        or owner_id = auth.uid()
    )
  );
create policy business_images_owner_update on storage.objects
  for update using (
    bucket_id = 'business-images'
    and split_part(name, '/', 1) in (
      select id::text
      from businesses
      where
        lower(owner_email) = lower(auth.jwt() ->> 'email')
        or owner_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'business-images'
    and split_part(name, '/', 1) in (
      select id::text
      from businesses
      where
        lower(owner_email) = lower(auth.jwt() ->> 'email')
        or owner_id = auth.uid()
    )
  );
create policy business_images_owner_delete on storage.objects
  for delete using (
    bucket_id = 'business-images'
    and split_part(name, '/', 1) in (
      select id::text
      from businesses
      where
        lower(owner_email) = lower(auth.jwt() ->> 'email')
        or owner_id = auth.uid()
    )
  );
