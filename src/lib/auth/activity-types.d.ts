export type AuthActivityAction = "auth.login" | "auth.logout" | "auth.mfa_verified" | "auth.password_reset" | "auth.device_login" | "auth.signup";

export type AuthActivityMetadata = {
	ipAddress: string;
	city: string | null;
	country: string | null;
	device: string;
	platform: string;
	userAgent: string;
};
