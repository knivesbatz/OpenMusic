use serde::{Serialize, Serializer};

use crate::state::Provider;

/// Errors returned to the UI. Serialized as `{ code, message }` (plus `provider` when the error
/// belongs to one) so the frontend can show a localized message for known codes and fall back to
/// `message` otherwise.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not signed in")]
    NotSignedIn,
    /// The provider refused the credentials. `None` for services that aren't providers (Last.fm);
    /// the UI only tries to recover an error that names its provider.
    #[error("session expired, please sign in again")]
    AuthExpired(Option<Provider>),
    /// The provider's switch is off in Settings → Services.
    #[error("{} is turned off in Settings", .0.label())]
    Disabled(Provider),
    #[error("server unavailable: {0}")]
    Offline(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not supported: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Invalid(String),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("data error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("credential store error: {0}")]
    Keyring(String),
    #[error("cancelled")]
    Cancelled,
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotSignedIn => "notSignedIn",
            Error::AuthExpired(_) => "authExpired",
            Error::Disabled(_) => "disabled",
            Error::Offline(_) => "offline",
            Error::NotFound(_) => "notFound",
            Error::Unsupported(_) => "unsupported",
            Error::Invalid(_) => "invalid",
            Error::Http(e) if e.is_timeout() || e.is_connect() => "offline",
            // A bare 401 from some other service (a download, a translation, MusicBrainz) is not a
            // provider session: provider call sites map their own 401s to AuthExpired(Some(_)).
            Error::Http(_) => "network",
            Error::Db(_) => "database",
            Error::Io(_) => "io",
            Error::Json(_) => "data",
            Error::Keyring(_) => "keyring",
            Error::Cancelled => "cancelled",
        }
    }

    /// The provider this error belongs to, when it names one.
    pub fn provider(&self) -> Option<Provider> {
        match self {
            Error::AuthExpired(p) => *p,
            Error::Disabled(p) => Some(*p),
            _ => None,
        }
    }

    pub fn is_auth_expired(&self) -> bool {
        matches!(self, Error::AuthExpired(_))
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let provider = self.provider();
        let mut st = s.serialize_struct("Error", if provider.is_some() { 3 } else { 2 })?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        if let Some(p) = provider {
            st.serialize_field("provider", &p)?;
        }
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_provider_when_known() {
        let v = serde_json::to_value(Error::AuthExpired(Some(Provider::Plex))).unwrap();
        assert_eq!(v["code"], "authExpired");
        assert_eq!(v["provider"], "plex");
        let v = serde_json::to_value(Error::AuthExpired(None)).unwrap();
        assert_eq!(v["code"], "authExpired");
        assert!(v.get("provider").is_none(), "no provider: the UI never recovers it");
        let v = serde_json::to_value(Error::Disabled(Provider::YouTube)).unwrap();
        assert_eq!(v["code"], "disabled");
        assert_eq!(v["provider"], "youtube");
        assert_eq!(v["message"], "YouTube Music is turned off in Settings");
        let v = serde_json::to_value(Error::NotSignedIn).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "notSignedIn", "message": "not signed in" }));
    }
}
