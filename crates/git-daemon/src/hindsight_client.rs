//! Rust caller for advisory Hindsight memory over gjc-rpc.
//!
//! Builds the `hindsight_recall`/`hindsight_retain`/`hindsight_reflect` command
//! envelopes the TS engine validates (the commands added in the protocol slice)
//! and parses recall responses into advisory snippets. Pure builders/parsers so
//! they are testable without a socket; the actual send is a thin transport.
//! Recall results are advisory only — they inform prompt context, never gate a
//! merge or override committed rules.

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::forge_adapter::ForgeError;
use crate::rpc_socket::RpcClient;

/// A recalled advisory memory snippet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecalledMemory {
	pub text: String,
	pub id: Option<String>,
	pub mem_type: Option<String>,
}

/// Build a `hindsight_recall` command. `None` options are omitted.
#[must_use]
pub fn recall_command(
	query: &str,
	types: Option<&[String]>,
	max_tokens: Option<u32>,
	tags: Option<&[String]>,
	tags_match: Option<&str>,
) -> Value {
	let mut cmd = json!({ "type": "hindsight_recall", "query": query });
	let obj = cmd.as_object_mut().expect("json object");
	if let Some(t) = types {
		obj.insert("types".into(), json!(t));
	}
	if let Some(m) = max_tokens {
		obj.insert("max_tokens".into(), json!(m));
	}
	if let Some(t) = tags {
		obj.insert("tags".into(), json!(t));
	}
	if let Some(tm) = tags_match {
		obj.insert("tags_match".into(), json!(tm));
	}
	cmd
}

/// Build a `hindsight_retain` command. `None` options are omitted.
#[must_use]
pub fn retain_command(
	content: &str,
	document_id: Option<&str>,
	context: Option<&str>,
	tags: Option<&[String]>,
) -> Value {
	let mut cmd = json!({ "type": "hindsight_retain", "content": content });
	let obj = cmd.as_object_mut().expect("json object");
	if let Some(d) = document_id {
		obj.insert("document_id".into(), json!(d));
	}
	if let Some(c) = context {
		obj.insert("context".into(), json!(c));
	}
	if let Some(t) = tags {
		obj.insert("tags".into(), json!(t));
	}
	cmd
}

/// Build a `hindsight_reflect` command. `None` options are omitted.
#[must_use]
pub fn reflect_command(query: &str, context: Option<&str>, tags: Option<&[String]>) -> Value {
	let mut cmd = json!({ "type": "hindsight_reflect", "query": query });
	let obj = cmd.as_object_mut().expect("json object");
	if let Some(c) = context {
		obj.insert("context".into(), json!(c));
	}
	if let Some(t) = tags {
		obj.insert("tags".into(), json!(t));
	}
	cmd
}

/// Parse a recall response (`{ results: [{ text, id?, type? }, ...] }`) into
/// advisory snippets. Unknown/malformed entries are skipped (advisory data is
/// best-effort; it never blocks a decision).
#[must_use]
pub fn parse_recall(response: &Value) -> Vec<RecalledMemory> {
	let Some(results) = response.get("results").and_then(Value::as_array) else {
		return Vec::new();
	};
	results
		.iter()
		.filter_map(|r| {
			let text = r.get("text").and_then(Value::as_str)?.to_owned();
			Some(RecalledMemory {
				text,
				id: r.get("id").and_then(Value::as_str).map(ToOwned::to_owned),
				mem_type: r.get("type").and_then(Value::as_str).map(ToOwned::to_owned),
			})
		})
		.collect()
}

/// Advisory Hindsight memory over a gjc-rpc stream.
///
/// Wraps an [`RpcClient`] and ties the pure command builders + [`parse_recall`]
/// to the transport. Generic over the stream so the send/receive flow is
/// duplex-testable offline. All results are advisory — they never gate a merge.
pub struct HindsightRpcClient<S> {
	client: RpcClient<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> HindsightRpcClient<S> {
	/// Wrap a connected [`RpcClient`].
	#[must_use]
	pub const fn new(client: RpcClient<S>) -> Self {
		Self { client }
	}

	/// Recall advisory memories. Returns an empty list on EOF (advisory data is
	/// best-effort and never blocks a decision).
	///
	/// # Errors
	/// Returns [`ForgeError`] on a transport failure.
	pub async fn recall(
		&mut self,
		query: &str,
		types: Option<&[String]>,
		max_tokens: Option<u32>,
		tags: Option<&[String]>,
		tags_match: Option<&str>,
	) -> Result<Vec<RecalledMemory>, ForgeError> {
		self.client.send(&recall_command(query, types, max_tokens, tags, tags_match)).await?;
		Ok(self.client.next_frame().await?.map(|f| parse_recall(&f)).unwrap_or_default())
	}

	/// Retain an advisory memory (fire-and-forget; no response is awaited).
	///
	/// # Errors
	/// Returns [`ForgeError`] on a transport failure.
	pub async fn retain(
		&mut self,
		content: &str,
		document_id: Option<&str>,
		context: Option<&str>,
		tags: Option<&[String]>,
	) -> Result<(), ForgeError> {
		self.client.send(&retain_command(content, document_id, context, tags)).await
	}

	/// Trigger a reflection (fire-and-forget; no response is awaited).
	///
	/// # Errors
	/// Returns [`ForgeError`] on a transport failure.
	pub async fn reflect(
		&mut self,
		query: &str,
		context: Option<&str>,
		tags: Option<&[String]>,
	) -> Result<(), ForgeError> {
		self.client.send(&reflect_command(query, context, tags)).await
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn recall_command_omits_none_options() {
		let c = recall_command("how is auth done", None, None, None, None);
		assert_eq!(c["type"], "hindsight_recall");
		assert_eq!(c["query"], "how is auth done");
		let obj = c.as_object().unwrap();
		assert!(!obj.contains_key("types"));
		assert!(!obj.contains_key("tags"));
	}

	#[test]
	fn recall_command_includes_set_options() {
		let tags = vec!["repo:acme/widget".to_owned()];
		let c = recall_command("q", None, Some(2000), Some(&tags), Some("any"));
		assert_eq!(c["max_tokens"], 2000);
		assert_eq!(c["tags"][0], "repo:acme/widget");
		assert_eq!(c["tags_match"], "any");
	}

	#[test]
	fn retain_and_reflect_command_shapes() {
		let r = retain_command("fixed the parser", Some("doc-1"), Some("issue 42"), None);
		assert_eq!(r["type"], "hindsight_retain");
		assert_eq!(r["content"], "fixed the parser");
		assert_eq!(r["document_id"], "doc-1");
		let f = reflect_command("what conventions apply", None, None);
		assert_eq!(f["type"], "hindsight_reflect");
		assert_eq!(f["query"], "what conventions apply");
	}

	#[test]
	fn parse_recall_extracts_results_and_skips_malformed() {
		let resp = json!({
			"results": [
				{ "text": "uses passport JWT", "id": "m1", "type": "convention" },
				{ "id": "m2" },
				{ "text": "prefers squash merges" }
			]
		});
		let mems = parse_recall(&resp);
		assert_eq!(mems.len(), 2);
		assert_eq!(mems[0].text, "uses passport JWT");
		assert_eq!(mems[0].id.as_deref(), Some("m1"));
		assert_eq!(mems[1].text, "prefers squash merges");
		assert!(mems[1].id.is_none());
	}

	#[test]
	fn parse_recall_empty_when_no_results() {
		assert!(parse_recall(&json!({})).is_empty());
		assert!(parse_recall(&json!({ "results": "nope" })).is_empty());
	}

	#[tokio::test]
	async fn recall_sends_command_and_parses_results() {
		use tokio::io::{AsyncReadExt, AsyncWriteExt};
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let mut hs = HindsightRpcClient::new(RpcClient::new(client_side));

		// Engine pre-loads a recall response frame.
		let resp = crate::rpc_framing::encode_frame(&json!({
			"results": [{ "text": "uses passport JWT", "id": "m1", "type": "convention" }]
		}));
		engine.write_all(resp.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();

		let tags = vec!["repo:acme/widget".to_owned()];
		let mems = hs.recall("how is auth done", None, Some(1500), Some(&tags), Some("any")).await.unwrap();
		assert_eq!(mems.len(), 1);
		assert_eq!(mems[0].text, "uses passport JWT");

		// The engine receives the recall command we sent.
		let mut buf = vec![0u8; 4096];
		let n = engine.read(&mut buf).await.unwrap();
		let sent: Value = serde_json::from_str(String::from_utf8_lossy(&buf[..n]).trim()).unwrap();
		assert_eq!(sent["type"], "hindsight_recall");
		assert_eq!(sent["query"], "how is auth done");
		assert_eq!(sent["tags_match"], "any");
	}

	#[tokio::test]
	async fn recall_returns_empty_on_empty_results() {
		use tokio::io::AsyncWriteExt;
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let frame = crate::rpc_framing::encode_frame(&json!({ "results": [] }));
		engine.write_all(frame.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let mut hs = HindsightRpcClient::new(RpcClient::new(client_side));
		let mems = hs.recall("q", None, None, None, None).await.unwrap();
		assert!(mems.is_empty());
	}

	#[tokio::test]
	async fn retain_sends_a_retain_command() {
		use tokio::io::AsyncReadExt;
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let mut hs = HindsightRpcClient::new(RpcClient::new(client_side));
		hs.retain("fixed the parser", Some("doc-1"), None, None).await.unwrap();
		let mut buf = vec![0u8; 4096];
		let n = engine.read(&mut buf).await.unwrap();
		let sent: Value = serde_json::from_str(String::from_utf8_lossy(&buf[..n]).trim()).unwrap();
		assert_eq!(sent["type"], "hindsight_retain");
		assert_eq!(sent["document_id"], "doc-1");
	}
}
