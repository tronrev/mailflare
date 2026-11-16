"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { suggestEmailCompletion } from "@/lib/auth/login-email-suggestion";

type EmailSuggestionInputProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> & {
	value: string;
	onChange: (value: string) => void;
	/** Domains that receive mail here; the first one is the fallback. */
	domains: string[];
	/** Hostname of the page, so the domain serving it can be preferred. */
	hostname: string;
	/** Called after Tab accepts the completion, usually to focus the next field. */
	onAccept?: () => void;
};

/**
 * An email input that shows the rest of the address as grey ghost text and
 * completes it on Tab. Escape hides the suggestion until the value changes, so
 * an address on another domain can still be typed.
 */
export function EmailSuggestionInput({
	value,
	onChange,
	domains,
	hostname,
	onAccept,
	className,
	...props
}: EmailSuggestionInputProps) {
	// The value the user dismissed the suggestion for. Comparing against it
	// keeps the ghost hidden until they type something new.
	const [dismissed, setDismissed] = React.useState<string | null>(null);

	const suggestion = React.useMemo(
		() => (dismissed === value ? null : suggestEmailCompletion(value, { domains, hostname })),
		[value, domains, hostname, dismissed],
	);

	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (!suggestion) return;
		if (event.key === "Tab" && !event.shiftKey) {
			event.preventDefault();
			onChange(suggestion.value);
			onAccept?.();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setDismissed(value);
		}
	}

	return (
		<div className="relative">
			{suggestion && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre border border-transparent px-3 text-sm"
				>
					<span className="invisible">{value}</span>
					<span className="text-neutral-400">{suggestion.suffix}</span>
				</div>
			)}
			<Input
				{...props}
				type="email"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				className={cn("relative", className)}
			/>
		</div>
	);
}
