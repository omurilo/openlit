import { User } from "@/lib/models";

export type UserStore = {
	details?: User;
	isFetched: boolean;
	set: (u: User) => void;
	reset: () => void;
};