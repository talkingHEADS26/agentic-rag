-- ══════════════════════════════════════════════════════════════
-- Agentic RAG Bot — Supabase Schema
-- Einmalig im Supabase SQL Editor ausführen:
-- https://supabase.com/dashboard → Projekt → SQL Editor → New query
-- ══════════════════════════════════════════════════════════════

-- 1. pgvector Extension aktivieren
create extension if not exists vector;

-- 2. Tabelle für Wissens-Chunks
create table if not exists knowledge_chunks (
  id         bigserial primary key,
  content    text        not null,
  embedding  vector(1536),
  metadata   jsonb,          -- { "source": "dateiname.md", "category": "general", "chunk_index": 0 }
  created_at timestamptz default now()
);

-- 3. Index für schnelle Vektorsuche (HNSW — empfohlen für pgvector >= 0.5)
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

-- 4. Suchfunktion (Cosine Similarity)
create or replace function match_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.55,
  match_count     int   default 4
)
returns table (
  id         bigint,
  content    text,
  metadata   jsonb,
  similarity float
)
language sql stable
as $$
  select
    id,
    content,
    metadata,
    1 - (embedding <=> query_embedding) as similarity
  from knowledge_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
