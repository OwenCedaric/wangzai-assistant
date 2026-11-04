namespace Wangzai.CefBrowserHost;

// Identity fence for launches waiting on asynchronous context initialization.
// Closing an owner must cancel its pending launch even before a session exists.
internal sealed class BrowserPendingLaunches
{
    internal sealed class Ticket
    {
        private readonly CancellationTokenSource cancellation = new();
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CancellationToken Token { get; }
        public Task Released => released.Task;
        public Ticket() { Token = cancellation.Token; }
        public void Cancel() { try { cancellation.Cancel(); } catch (ObjectDisposedException) { } }
        public void Complete() { released.TrySetResult(); cancellation.Dispose(); }
    }
    internal sealed record Cancellation(Task Released);
    private readonly object gate = new();
    private readonly Dictionary<string, List<Ticket>> pending = new(StringComparer.Ordinal);
    public int Count { get { lock (gate) return pending.Values.Sum(tickets => tickets.Count); } }
    public Ticket Begin(string ownerRef)
    {
        Ticket ticket = new();
        lock (gate)
        {
            if (!pending.TryGetValue(ownerRef, out var tickets)) pending[ownerRef] = tickets = new();
            foreach (var previous in tickets) previous.Cancel();
            tickets.Add(ticket);
        }
        return ticket;
    }
    public void Verify(string ownerRef, Ticket ticket)
    {
        lock (gate)
        {
            if (ticket.Token.IsCancellationRequested || !pending.TryGetValue(ownerRef, out var tickets)
                || !ReferenceEquals(tickets.LastOrDefault(), ticket)) throw new InvalidOperationException("PURCHASE_BROWSER_SESSION_STALE");
        }
    }
    public Cancellation? Cancel(string ownerRef)
    {
        lock (gate)
        {
            if (!pending.TryGetValue(ownerRef, out var tickets)) return null;
            foreach (var ticket in tickets) ticket.Cancel();
            return new(Task.WhenAll(tickets.Select(ticket => ticket.Released)));
        }
    }
    public void Complete(string ownerRef, Ticket ticket)
    {
        lock (gate)
        {
            if (pending.TryGetValue(ownerRef, out var tickets))
            {
                tickets.Remove(ticket);
                if (tickets.Count == 0) pending.Remove(ownerRef);
            }
        }
        ticket.Complete();
    }
    public Task CancelAll()
    {
        lock (gate)
        {
            var tickets = pending.Values.SelectMany(value => value).ToArray();
            foreach (var ticket in tickets) ticket.Cancel();
            return Task.WhenAll(tickets.Select(ticket => ticket.Released));
        }
    }
}
