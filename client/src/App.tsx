import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import GroupDetail from "@/pages/GroupDetail";
import Upload from "@/pages/Upload";
import Reports from "@/pages/Reports";
import DailyBrief from "@/pages/cos/DailyBrief";
import Inbox from "@/pages/cos/Inbox";
import Teams from "@/pages/cos/Teams";
import Intake from "@/pages/cos/Intake";
import Reminders from "@/pages/cos/Reminders";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/group/:id" component={GroupDetail} />
          <Route path="/upload" component={Upload} />
          <Route path="/reports" component={Reports} />
          <Route path="/cos" component={DailyBrief} />
          <Route path="/cos/inbox" component={Inbox} />
          <Route path="/cos/teams" component={Teams} />
          <Route path="/cos/intake" component={Intake} />
          <Route path="/cos/reminders" component={Reminders} />
          <Route component={NotFound} />
        </Switch>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}
