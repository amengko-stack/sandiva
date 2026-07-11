import MessagesPage from "./MessagesPage";

export default function Inbox() {
  return (
    <MessagesPage
      source="email"
      title="Inbox"
      subtitle="Triaged email — urgent items first, noise filtered out"
    />
  );
}
