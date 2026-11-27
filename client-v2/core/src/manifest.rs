//! `stems/chunks/chunks.json`. Bounds match `parseChunkManifest`.

use crate::CoreError;

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkManifest {
    pub chunk_seconds: f64,
    pub ext: String,
    pub sample_rate_hint: Option<u32>,
    pub stems: Vec<(String, u32)>,
}

pub fn parse_chunk_manifest(raw: &str) -> Result<ChunkManifest, CoreError> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| CoreError::Message(format!("chunks.json: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| CoreError::Message("chunks.json is not an object".into()))?;

    let chunk_seconds = obj
        .get("chunkSeconds")
        .and_then(|v| v.as_f64())
        .filter(|s| (5.0..=120.0).contains(s))
        .ok_or_else(|| CoreError::Message("chunkSeconds must be between 5 and 120".into()))?;

    let ext = match obj.get("ext").and_then(|v| v.as_str()) {
        Some(ext) if matches!(ext, "flac" | "opus" | "ogg") => ext.to_string(),
        _ => "flac".to_string(),
    };

    let sample_rate_hint = obj
        .get("sampleRate")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let stems_val = obj
        .get("stems")
        .and_then(|v| v.as_object())
        .ok_or_else(|| CoreError::Message("chunks.json has no stems".into()))?;

    let mut stems = Vec::new();
    for (name, info) in stems_val {
        let Some(count) = info.get("count").and_then(|v| v.as_f64()) else {
            continue;
        };
        if count > 0.0 && count.fract() == 0.0 && count <= u32::MAX as f64 {
            stems.push((name.clone(), count as u32));
        }
    }
    if stems.is_empty() {
        return Err(CoreError::Message("chunks.json has no usable stems".into()));
    }
    stems.sort_by(|a, b| a.0.cmp(&b.0));

    Ok(ChunkManifest {
        chunk_seconds,
        ext,
        sample_rate_hint,
        stems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> serde_json::Value {
        serde_json::json!({
            "chunkSeconds": 30,
            "ext": "opus",
            "stems": { "vocals": { "count": 10 }, "bass": { "count": 10 } }
        })
    }

    #[test]
    fn parses_a_valid_manifest() {
        let m = parse_chunk_manifest(&valid().to_string()).unwrap();
        assert_eq!(m.chunk_seconds, 30.0);
        assert_eq!(m.ext, "opus");
        assert_eq!(m.stems, vec![("bass".into(), 10), ("vocals".into(), 10)]);
    }

    #[test]
    fn rejects_out_of_bounds_chunk_seconds() {
        for seconds in [4.0, 121.0] {
            let mut v = valid();
            v["chunkSeconds"] = serde_json::json!(seconds);
            assert!(parse_chunk_manifest(&v.to_string()).is_err());
        }
    }

    #[test]
    fn defaults_unknown_ext_to_flac() {
        let mut v = valid();
        v["ext"] = serde_json::json!("mp3");
        let m = parse_chunk_manifest(&v.to_string()).unwrap();
        assert_eq!(m.ext, "flac");
    }

    #[test]
    fn drops_invalid_counts_and_rejects_an_empty_set() {
        let mut v = valid();
        v["stems"] = serde_json::json!({
            "vocals": { "count": 10 },
            "bad": { "count": 0 },
            "worse": { "count": 1.5 }
        });
        let m = parse_chunk_manifest(&v.to_string()).unwrap();
        assert_eq!(m.stems, vec![("vocals".into(), 10)]);

        v["stems"] = serde_json::json!({});
        assert!(parse_chunk_manifest(&v.to_string()).is_err());
        v["stems"] = serde_json::json!({ "x": { "count": -1 } });
        assert!(parse_chunk_manifest(&v.to_string()).is_err());
    }
}
