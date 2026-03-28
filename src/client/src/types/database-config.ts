import { DatabaseConfig as DatabaseConfigModel } from "@/lib/models";
import { MouseEventHandler } from "react";

export interface DatabaseConfig extends DatabaseConfigModel {}

export type DatabaseConfigTabItemProps = {
	id: string;
	name: string;
	badge?: string;
	isCurrent?: boolean;
	canDelete?: boolean;
	canShare?: boolean;
	canEdit?: boolean;
};

export type DatabaseConfigTabsProps = {
	items: DatabaseConfigTabItemProps[];
	onClickTab: MouseEventHandler<HTMLElement>;
	selectedTabId: string;
	onClickItemDelete?: MouseEventHandler<SVGSVGElement>;
	onClickItemChangeActive: MouseEventHandler<HTMLDivElement>;
	addButton?: boolean;
};
