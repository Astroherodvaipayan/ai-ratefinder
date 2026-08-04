#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const continueOnError = args.includes('--continue-on-error')
const documentOption = option('document')
const resumeFrom = option('resume-from')
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})
let query = supabase
  .from('documents')
  .select('id, filename, status, page_count, storage_path, mime, created_at')
  .not('storage_path', 'is', null)
  .order('created_at', { ascending: true })
if (documentOption) query = query.eq('id', documentOption)
const { data, error } = await query
if (error) throw error

let documents = (data ?? []).filter(document =>
  /\.pdf$/i.test(document.filename ?? '') || /pdf/i.test(document.mime ?? ''))
if (resumeFrom) {
  const start = documents.findIndex(document => document.id === resumeFrom)
  if (start < 0) throw new Error(`--resume-from document was not found: ${resumeFrom}`)
  documents = documents.slice(start)
}

console.log(JSON.stringify({
  mode: execute ? 'execute' : 'dry-run',
  documents: documents.length,
  pages: documents.reduce((sum, document) => sum + Number(document.page_count ?? 0), 0),
  parser_mode: process.env.CHANDRA_MODE || 'accurate',
  pages_per_chunk: Number(process.env.CHANDRA_PAGES_PER_CHUNK || 1),
  document_ids: documents.map(document => document.id)
}, null, 2))

if (!execute) {
  console.log('Dry run only. Add --execute to perform staged reparsing. Existing rows remain live until each candidate passes its quality gate.')
  process.exit(0)
}

const failures = []
for (const [index, document] of documents.entries()) {
  console.log(`\n[${index + 1}/${documents.length}] ${document.filename}`)
  const exitCode = await runDocument(document.id)
  if (exitCode === 0) continue
  failures.push({ id: document.id, filename: document.filename, exit_code: exitCode })
  if (!continueOnError) break
}

console.log(JSON.stringify({
  attempted: documents.length,
  failures,
  completed: failures.length === 0
}, null, 2))
if (failures.length) process.exitCode = 1

function option(name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : null
}

function runDocument(documentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/reparse-doc-chandra-chunks.mjs', documentId], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('exit', code => resolve(code ?? 1))
  })
}
