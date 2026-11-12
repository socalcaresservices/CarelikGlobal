import { createContext, useContext } from "react";

export interface PageHelpValue {
  slot: HTMLElement | null;
  count: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  register: (id: string) => () => void;
}
export const PageHelpContext = createContext<PageHelpValue | null>(null);
export const usePageHelp = () => useContext(PageHelpContext);

