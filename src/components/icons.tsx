/**
 * One place to import an icon from.
 *
 * The upstream project swapped this module's contents for @hugeicons. This
 * tree keeps lucide-react, so merging upstream files does not restyle every
 * screen: the names below are the same ones the UI already imported.
 */
import type { ComponentProps } from "react";
import type { LucideIcon as LucideIconType } from "lucide-react";
import { Mail, MoreHorizontal, Pencil, Send, StickyNote } from "lucide-react";

export type { LucideIconType };
export type LucideIcon = LucideIconType;
export type IconProps = ComponentProps<LucideIconType>;
export type IconNode = LucideIconType;

export {
	Activity, AlertCircle, AlertTriangle, AlignLeft, Archive, ArchiveRestore,
	ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, AtSign,
	BadgeDollarSign, Ban, Bell, BellOff, BellRing, Bold,
	Bot, Building2, CalendarClock, CalendarDays, CalendarPlus2, Camera,
	Check, CheckCircle2, CheckSquare2, ChevronDown, ChevronLeft, ChevronRight,
	ChevronUp, ChevronsUpDown, CircleX, Clock, Clock3, Cloud,
	Columns2, Copy, CornerDownLeft, CornerDownRight, Database, DatabaseBackup,
	Download, ExternalLink, Eye, EyeOff, File, FileArchive,
	FileAudio, FileCode, FileCode2, FileImage, FileSpreadsheet, FileText,
	FileType, FileVideo, FileVideoCamera, FileWarning, Folder, FolderInput,
	FolderPlus, Forward, Globe2, HardDrive, HelpCircle, Image,
	ImagePlus, Inbox, Info, Italic, KeyRound, Keyboard,
	Link2, List, ListChecks, ListFilter, ListOrdered, Loader2,
	LockKeyhole, LogIn, LogOut, Mail, MailCheck, MailOpen,
	MailPlus, MapPin, Maximize2, Menu, Minimize2, Minus,
	MoreHorizontal, MoreVertical, Music, Palette, Paperclip, Pause,
	PauseCircle, PenLine, Pencil, Play, Plus, Presentation,
	Quote, RefreshCw, RemoveFormatting, Repeat2, Reply, ReplyAll,
	RotateCcw, RotateCw, Route, Save, Search, Send,
	Server, Settings, Settings2, Share2, Shield, ShieldAlert,
	ShieldCheck, ShieldOff, Smartphone, Sparkles, Square, Star,
	Strikethrough, TextAlignJustify, Trash2, Underline, Undo2, Upload,
	UploadCloud, User, UserPlus, UserRound, Users, UsersRound,
	Webhook, Wrench, X, XCircle, LoaderCircle, ArchiveIcon,
	InboxIcon, ShieldIcon, ShieldAlertIcon, Trash2Icon, TrashIcon,
} from "lucide-react";

/** Mobile menu glyph, drawn here because no icon library ships this exact mark. */
export function HamburgerMenuIcon({ size = 24, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<rect height="1" width="11" x="0.5" y="2.5" />
			<rect height="1" width="11" x="0.5" y="5.5" />
			<rect height="1" width="11" x="0.5" y="8.5" />
		</svg>
	);
}

/** Upstream names that lucide spells differently. */
export const More01 = MoreHorizontal;
export const Edit04 = Pencil;
export const MailSend01 = Send;
export const Note = StickyNote;
