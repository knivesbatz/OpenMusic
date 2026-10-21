use serde::{Serialize, Serializer};

/// Errors returned to the UI. Serialized as `{ code, message }` so the frontend can show a
/// localized message for known codes and fall back to `message` otherwise.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not signed in")]
    NotSignedIn,
    #[error("session expired, please sign in again")]
    AuthExpired,
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
            Error::AuthExpired => "authExpired",
            Error::Offline(_) => "offline",
            Error::NotFound(_) => "notFound",
            Error::Unsupported(_) => "unsupported",
            Error::Invalid(_) => "invalid",
            Error::Http(e) if e.is_timeout() || e.is_connect() => "offline",
            Error::Http(e) if e.status().map(|s| s.as_u16()) == Some(401) => "authExpired",
            Error::Http(_) => "network",
            Error::Db(_) => "database",
            Error::Io(_) => "io",
            Error::Json(_) => "data",
            Error::Keyring(_) => "keyring",
            Error::Cancelled => "cancelled",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
