#!/usr/bin/env node
const FLOW_REST = "https://rest-mainnet.onflow.org"

function unwrap(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrap)
  if (typeof node !== "object") return node
  const { type, value } = node
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrap(value)
      case "Array": return value.map(unwrap)
      case "Dictionary": {
        const o = {}
        for (const kv of value) o[String(unwrap(kv.key))] = unwrap(kv.value)
        return o
      }
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
        const o = {}
        for (const f of (value.fields ?? [])) o[f.name] = unwrap(f.value)
        return o
      }
      default: return value
    }
  }
  return node
}

async function run(code, args = []) {
  const body = {
    script: Buffer.from(code).toString("base64"),
    arguments: args.map(a => Buffer.from(JSON.stringify(a)).toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  // Flow REST returns a JSON string (base64 of JSON-CDC) directly, not an object
  const b64 = JSON.parse(text)
  return unwrap(JSON.parse(Buffer.from(b64, "base64").toString("utf8")))
}

const main = async () => {
  console.log("nextEditionID:", await run(`
import Golazos from 0x87ca73a41bb50ad5
access(all) fun main(): UInt64 { return Golazos.nextEditionID }`))

  console.log("\nEdition 1:")
  console.log(JSON.stringify(await run(`
import Golazos from 0x87ca73a41bb50ad5
access(all) fun main(id: UInt64): {String: AnyStruct}? {
  if let ed = Golazos.getEditionData(id: id) {
    let out: {String: AnyStruct} = {
      "id": ed.id, "seriesID": ed.seriesID, "setID": ed.setID, "playID": ed.playID,
      "tier": ed.tier, "maxMintSize": ed.maxMintSize, "numMinted": ed.numMinted
    }
    if let p = Golazos.getPlayData(id: ed.playID) { out["playMetadata"] = p.metadata; out["classification"] = p.classification }
    if let s = Golazos.getSetData(id: ed.setID) { out["setName"] = s.name }
    out["seriesName"] = Golazos.getSeriesData(id: ed.seriesID).name
    return out
  }
  return nil
}`, [{ type: "UInt64", value: "1" }]), null, 2))
}
main().catch(e => { console.error(e); process.exit(1) })
