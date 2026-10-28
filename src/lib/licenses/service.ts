import type { LicenseEntitlements } from "./types";

/**
 * 2026-10-28 自托管分支：这一份邮件服务没有付费门槛。
 *
 * 上游把「建账号 / 共享信箱 / 定制品牌 / 邮件转发」四个开关绑在 paymug 的
 * Pro / Team 授权上，社区版一律关掉 —— 结果是「程序化建账号」在社区版根本
 * 做不到：`POST /api/v1/accounts` 永远 403（"A Pro or Team license is
 * required to manage accounts"），而给每个用户开一个**能登录**的独立邮箱，
 * 恰恰需要一个账号。本部署要把「注册即开通同名同密码邮箱」做成默认能力，
 * 所以这里直接全开、席位不限，并把 `/licenses` 页面与 `/api/licenses`
 * 一并删掉：没有可售卖的东西，留着只会误导。
 *
 * 想恢复上游行为，把下面这个常量换回 `getLicenseStatus()` 的判定即可
 * （本文件在 2026-10-28 之前的实现就是那一版）。
 */
const SELF_HOSTED_ENTITLEMENTS: LicenseEntitlements = {
	plan: "team",
	canCustomizeBranding: true,
	canManageAccounts: true,
	canShareMailboxes: true,
	accountSeatLimit: null,
	canForwardEmail: true,
};

export async function getLicenseEntitlements(_env: CloudflareEnv): Promise<LicenseEntitlements> {
	return SELF_HOSTED_ENTITLEMENTS;
}
