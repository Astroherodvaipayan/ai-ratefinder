#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl) throw new Error('SUPABASE_URL is required')
if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')

const supabase = createClient(supabaseUrl, serviceRoleKey)
const { data, error } = await supabase
  .from('documents')
  .select('id, filename, status, created_at, vendor:vendor_id(name)')
  .eq('status', 'parsed')
  .order('created_at', { ascending: true })
if (error) throw error

const docs = data ?? []
console.log(`Backfilling ${docs.length} parsed documents`)
let ok = 0

for (const [index, doc] of docs.entries()) {
  const label = `${doc.vendor?.name ?? 'no vendor'} | ${doc.filename}`
  console.log(`\n[${index + 1}/${docs.length}] ${label}`)
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/backfill-canonical-doc.mjs', doc.id], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (out.trim()) console.log(out.trim())
      if (err.trim()) console.error(err.trim())
      if (code === 0) {
        ok += 1
        resolve()
      } else {
        reject(new Error(`backfill failed for ${doc.id} with code ${code}`))
      }
    })
  })
}

console.log(`\nBackfill complete: ${ok}/${docs.length}`)
