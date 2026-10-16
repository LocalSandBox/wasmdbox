use std::{collections::BTreeMap, env, fs};
use webc::{metadata::Manifest, v3::{SignatureAlgorithm, Timestamps, write::{FileEntry, Writer}}};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    assert_eq!(args.len(), 3, "usage: fixture-writer manifest.json atom.wasm output.webc");
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args[0])?)?;
    let atom = fs::read(&args[1])?;
    let atoms = BTreeMap::from([("hello".parse()?, FileEntry::borrowed(&atom, Timestamps::default()))]);
    let bytes = Writer::default().write_manifest(&manifest)?.write_atoms(atoms)?.finish(SignatureAlgorithm::None)?;
    fs::write(&args[2], bytes)?;
    Ok(())
}
