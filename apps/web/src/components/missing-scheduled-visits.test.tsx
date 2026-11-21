import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/providers/organization-provider";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import { MissingScheduledVisits } from "./missing-scheduled-visits";
vi.mock("@/providers/organization-provider",()=>({useOrganization:vi.fn()}));
vi.mock("@/lib/sv-backend-supabase",()=>({useServiceVerificationBackend:vi.fn()}));
const list=vi.fn(), record=vi.fn();
const row={shiftId:"shift",clientId:"client",clientCode:"SYN-001",serviceName:"Respite",caregiverName:"Synthetic Caregiver",startsAt:"2026-10-20T16:00:00Z",endsAt:"2026-10-20T18:00:00Z",canRecord:true};
const filters={clientId:null,serviceId:null,caregiverUserId:null,dateFrom:"2026-10-01",dateTo:"2026-10-31",status:null};
function show(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MissingScheduledVisits filters={filters}/></QueryClientProvider>);}
beforeEach(()=>{
  vi.clearAllMocks(); list.mockResolvedValue([row]); record.mockResolvedValue("visit");
  vi.mocked(useOrganization).mockReturnValue({activeOrganizationId:"org",hasPermission:()=>true} as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useServiceVerificationBackend).mockReturnValue({listMissingScheduledVisits:list,recordMissingScheduledVisit:record} as unknown as ReturnType<typeof useServiceVerificationBackend>);
});
describe("missing scheduled records",()=>{
  it("shows missing records, leaves actual punches blank and requires actual times and a reason",async()=>{
    show(); fireEvent.click(await screen.findByRole("button",{name:"Record actual times"}));
    expect(screen.getByLabelText("Actual Time In hour")).toHaveValue("");
    fireEvent.click(screen.getByRole("button",{name:"Save actual times"}));
    expect(record).not.toHaveBeenCalled();
    for(const [label,hour] of [["Actual Time In","9"],["Actual Time Out","11"]]){
      fireEvent.change(screen.getByLabelText(`${label} hour`),{target:{value:hour}});
      fireEvent.change(screen.getByLabelText(`${label} minute`),{target:{value:"0"}});
      fireEvent.click(within(screen.getByRole("radiogroup",{name:`${label} AM or PM`})).getByRole("radio",{name:"AM"}));
    }
    fireEvent.click(screen.getByRole("button",{name:"Save actual times"}));
    expect(screen.getByRole("alert")).toHaveTextContent("reason of at least 10");
    expect(record).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/What you verified/),{target:{value:"Verified with the family and caregiver."}});
    fireEvent.click(screen.getByRole("button",{name:"Save actual times"}));
    await waitFor(()=>expect(record).toHaveBeenCalledWith(expect.objectContaining({shiftId:"shift",timeIn:"2026-10-20T16:00:00.000Z",timeOut:"2026-10-20T18:00:00.000Z",reason:"Verified with the family and caregiver."})));
    expect(await screen.findByText(/Next: collect client confirmation/)).toBeInTheDocument();
  });
  it("shows failure as an incomplete report, never as no exceptions",async()=>{
    list.mockRejectedValue(new Error("offline")); show();
    expect(await screen.findByRole("alert")).toHaveTextContent("exception report is incomplete");
    expect(screen.queryByText(/No missing scheduled/)).not.toBeInTheDocument();
  });
  it("does not fetch or expose records without report permission",()=>{
    vi.mocked(useOrganization).mockReturnValue({activeOrganizationId:"org",hasPermission:()=>false} as unknown as ReturnType<typeof useOrganization>);
    show(); expect(list).not.toHaveBeenCalled(); expect(screen.queryByText(/Synthetic Caregiver/)).not.toBeInTheDocument();
  });
  it("allows report readers to inspect missing records without a correction action",async()=>{
    vi.mocked(useOrganization).mockReturnValue({activeOrganizationId:"org",hasPermission:(p:string)=>p==="visits.read"} as unknown as ReturnType<typeof useOrganization>);
    show(); expect(await screen.findByText(/Synthetic Caregiver/)).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Record actual times"})).not.toBeInTheDocument();
  });
});
