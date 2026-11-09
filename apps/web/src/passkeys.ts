function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

type CredentialDescriptorJSON = Omit<PublicKeyCredentialDescriptor, "id" | "transports"> & {
  id: string;
  transports?: AuthenticatorTransport[];
};

export type RegistrationOptionsJSON = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: CredentialDescriptorJSON[];
};

export type AuthenticationOptionsJSON = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: CredentialDescriptorJSON[];
};

function descriptors(values: CredentialDescriptorJSON[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return values?.map((credential) => ({
    ...credential,
    id: decodeBase64Url(credential.id)
  }));
}

function requirePasskeys(): void {
  if (!("PublicKeyCredential" in window) || !navigator.credentials) {
    throw new Error("This browser does not support passkeys. Use a current Safari, Chrome, Edge, or Firefox browser.");
  }
}

export async function createAdminPasskey(options: RegistrationOptionsJSON): Promise<unknown> {
  requirePasskeys();
  const { challenge, user, excludeCredentials, ...rest } = options;
  const credential = await navigator.credentials.create({
    publicKey: {
      ...rest,
      challenge: decodeBase64Url(challenge),
      user: { ...user, id: decodeBase64Url(user.id) },
      ...(excludeCredentials ? { excludeCredentials: descriptors(excludeCredentials)! } : {})
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Passkey enrollment was cancelled or returned an unsupported response.");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      attestationObject: encodeBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? []
    }
  };
}

export async function authenticateAdminPasskey(options: AuthenticationOptionsJSON): Promise<unknown> {
  requirePasskeys();
  const { challenge, allowCredentials, ...rest } = options;
  const credential = await navigator.credentials.get({
    publicKey: {
      ...rest,
      challenge: decodeBase64Url(challenge),
      ...(allowCredentials ? { allowCredentials: descriptors(allowCredentials)! } : {})
    }
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Passkey authentication was cancelled or returned an unsupported response.");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      authenticatorData: encodeBase64Url(credential.response.authenticatorData),
      signature: encodeBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle ? encodeBase64Url(credential.response.userHandle) : undefined
    }
  };
}
