//! Live `reqwest` implementation of [`crate::github_forge::HttpTransport`].
//!
//! This is intentionally thin: it maps the crate’s transport-neutral
//! [`HttpRequest`]/[`HttpResponse`] onto `reqwest` and back. All
//! GitHub-specific logic (URLs, headers, body, status->error mapping) lives in
//! `github_forge` and is unit-tested there with a fake transport; this adapter
//! only performs the actual network send, which is verified live (it has no
//! offline test).

use crate::{
	forge_adapter::ForgeError,
	github_forge::{HttpRequest, HttpResponse, HttpTransport},
};

/// A `reqwest`-backed HTTP transport.
pub struct ReqwestTransport {
	client: reqwest::Client,
}

impl ReqwestTransport {
	/// Build a transport with a default client.
	///
	/// # Errors
	/// Returns [`ForgeError::Transient`] if the underlying client cannot be
	/// built.
	pub fn new() -> Result<Self, ForgeError> {
		let client = reqwest::Client::builder()
			.build()
			.map_err(|e| ForgeError::Transient(format!("reqwest client build: {e}")))?;
		Ok(Self { client })
	}

	/// Build a transport from an existing client (e.g. with custom timeouts).
	#[must_use]
	pub const fn with_client(client: reqwest::Client) -> Self {
		Self { client }
	}
}

impl HttpTransport for ReqwestTransport {
	async fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
		let method = reqwest::Method::from_bytes(req.method.as_bytes())
			.map_err(|e| ForgeError::Transient(format!("bad method: {e}")))?;
		let mut builder = self.client.request(method, &req.url);
		for (k, v) in &req.headers {
			builder = builder.header(k, v);
		}
		if let Some(body) = req.body {
			builder = builder.body(body);
		}
		let resp = builder
			.send()
			.await
			.map_err(|e| ForgeError::Transient(format!("send: {e}")))?;
		let status = resp.status().as_u16();
		let body = resp
			.text()
			.await
			.map_err(|e| ForgeError::Transient(format!("read body: {e}")))?;
		Ok(HttpResponse { status, body })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn transport_builds() {
		// The client builds offline; actual sends are verified against a live API.
		assert!(ReqwestTransport::new().is_ok());
	}
}
