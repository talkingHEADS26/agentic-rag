// core/ingestKnowledge.js
// Dokumente in Supabase pgvector laden — einmalig oder bei Updates

import { createClient } from "@supabase/supabase-js";
import { readdir, readFile } from "fs/promises";
import path from "path";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Chunking ─────────────────────────────────────────────────────────────────
function chunkText(text, chunkSize = 800, overlap = 150) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }

  return chunks.filter((c) => c.length > 50);
}

// ─── Embedding ────────────────────────────────────────────────────────────────
async function embedBatch(texts) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: "text-embedding-3-small",
    }),
  });

  const data = await response.json();
  return data.data.map((d) => d.embedding);
}

// ─── Dokument verarbeiten ─────────────────────────────────────────────────────
async function ingestDocument(filePath, category = "general") {
  const content = await readFile(filePath, "utf-8");
  const fileName = path.basename(filePath);
  const chunks = chunkText(content);

  console.log(`📄 ${fileName}: ${chunks.length} Chunks`);

  // In Batches von 20 embedden (OpenAI Rate Limit)
  const batchSize = 20;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch);

    const rows = batch.map((chunk, idx) => ({
      content: chunk,
      embedding: embeddings[idx],
      metadata: {
        source: fileName,
        category,
        chunk_index: i + idx,
      },
    }));

    const { error } = await supabase.from("knowledge_chunks").insert(rows);
    if (error) throw new Error(`Supabase insert error: ${error.message}`);

    console.log(
      `   ✅ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)} gespeichert`
    );

    // Rate limit pause
    if (i + batchSize < chunks.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ─── Alle Docs in einem Ordner laden ─────────────────────────────────────────
async function ingestFolder(folderPath, category) {
  const files = await readdir(folderPath);
  const txtFiles = files.filter(
    (f) => f.endsWith(".txt") || f.endsWith(".md")
  );

  for (const file of txtFiles) {
    await ingestDocument(path.join(folderPath, file), category);
  }

  console.log(`\n✅ ${txtFiles.length} Dokumente aus "${folderPath}" geladen`);
}

// ─── Supabase Schema erstellen (einmalig) ─────────────────────────────────────
export async function setupSupabaseSchema() {
  // Diese SQL einmalig in der Supabase SQL Console ausführen:
  const sql = `
-- pgvector Extension
create extension if not exists vector;

-- Knowledge Chunks Tabelle
create table if not exists knowledge_chunks (
  id bigserial primary key,
  content text not null,
  embedding vector(1536),  -- text-embedding-3-small Dimension
  metadata jsonb,
  created_at timestamptz default now()
);

-- Index für schnelle Vektorsuche
create index if not exists knowledge_chunks_embedding_idx 
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- RPC Funktion für die Suche (match_chunks)
create or replace function match_chunks(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
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
  order by similarity desc
  limit match_count;
$$;
  `;

  console.log(
    "📋 Führe dieses SQL in der Supabase SQL Console aus:\n\n",
    sql
  );
}

// ─── Einzelnen Text direkt ingestieren (für Admin-Upload) ─────────────────────
export async function ingestText({ content, filename, category = "general" }) {
  const chunks = chunkText(content);
  const rows = [];

  const batchSize = 20;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch);

    for (let j = 0; j < batch.length; j++) {
      rows.push({
        content: batch[j],
        embedding: embeddings[j],
        metadata: { source: filename, category, chunk_index: i + j },
      });
    }

    if (i + batchSize < chunks.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const { error } = await supabase.from("knowledge_chunks").insert(rows);
  if (error) throw new Error(`Supabase insert error: ${error.message}`);

  return { chunks: rows.length, filename, category };
}

// ─── Alle Chunks löschen ──────────────────────────────────────────────────────
export async function deleteAllChunks() {
  const { error } = await supabase.from("knowledge_chunks").delete().neq("id", 0);
  if (error) throw new Error(error.message);
}

// ─── Chunks-Statistik ─────────────────────────────────────────────────────────
export async function getChunkStats() {
  const { data, error } = await supabase
    .from("knowledge_chunks")
    .select("metadata");
  if (error) throw new Error(error.message);

  const bySource = {};
  for (const row of data) {
    const src = row.metadata?.source || "unknown";
    const cat = row.metadata?.category || "general";
    const key = `${src}|||${cat}`;
    bySource[key] = (bySource[key] || 0) + 1;
  }

  return Object.entries(bySource).map(([key, count]) => {
    const [source, category] = key.split("|||");
    return { source, category, count };
  });
}

// ─── CLI Usage ────────────────────────────────────────────────────────────────
// node core/ingestKnowledge.js ./docs/sales Sales
// node core/ingestKnowledge.js ./docs/coaching Coaching

const [, , folderArg, categoryArg] = process.argv;
if (folderArg) {
  await ingestFolder(folderArg, categoryArg || "general");
}
