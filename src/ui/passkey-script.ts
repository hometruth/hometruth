/** Shared by the sign-in and security pages; uses the browser's WebAuthn JSON codec. */
export const PASSKEY_SCRIPT = `
  const passkeysSupported = window.isSecureContext && window.PublicKeyCredential
    && typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function"
    && typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function";
  async function signInWithPasskey() {
    const options = await ht.request("/api/auth/passkeys/authenticate/options", { method: "POST", body: "{}" });
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    if (!credential) throw new Error(ht.t("auth.passkey.failed"));
    await ht.request("/api/auth/passkeys/authenticate/verify", { method: "POST", body: JSON.stringify(credential.toJSON()) });
  }
`;
