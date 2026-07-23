using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using Unity.Services.Multiplayer;
using UnityEngine;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Sessions
{
    public sealed class MultiplayerSessionController : MonoBehaviour
    {
        [SerializeField] private VoiceChannelController voice;

        private ISession activeSession;

        public string RoomCode { get; private set; } = string.Empty;
        public bool IsConnected { get; private set; }
        public bool IsVoiceConnected => voice != null && voice.IsConnected;
        public string VoiceWarning { get; private set; } = string.Empty;
        public int ParticipantCount => activeSession?.PlayerCount ?? 0;

        public event Action<int> ParticipantCountChanged;

        public async Task<string> CreateRoomAsync()
        {
            await EnsureServicesAsync();
            await ReuseTargetOrLeaveExistingAsync(null);
            var options = new SessionOptions
            {
                MaxPlayers = 2,
                Name = "Virtual Makerspace CPS",
                IsPrivate = true
            }.WithRelayNetwork();

            IHostSession session;
            try
            {
                session = await MultiplayerService.Instance.CreateSessionAsync(options);
            }
            catch (SessionException exception) when (IsMembershipConflict(exception))
            {
                Debug.LogWarning("A stale lobby membership appeared during room creation; cleaning it and retrying once.");
                await Task.Delay(500);
                await ReuseTargetOrLeaveExistingAsync(null);
                session = await MultiplayerService.Instance.CreateSessionAsync(options);
            }
            SetActiveSession(session);
            await TryConnectVoiceAsync();
            return RoomCode;
        }

        public async Task JoinRoomAsync(string roomCode)
        {
            string normalizedCode = NormalizeRoomCode(roomCode);
            await EnsureServicesAsync();
            ISession existing = await ReuseTargetOrLeaveExistingAsync(normalizedCode);
            if (existing == null)
            {
                try
                {
                    existing = await MultiplayerService.Instance.JoinSessionByCodeAsync(normalizedCode);
                }
                catch (SessionException exception) when (IsMembershipConflict(exception))
                {
                    Debug.LogWarning("A stale lobby membership appeared during room join; cleaning it and retrying once.");
                    await Task.Delay(500);
                    existing = await ReuseTargetOrLeaveExistingAsync(normalizedCode);
                    existing ??= await MultiplayerService.Instance.JoinSessionByCodeAsync(normalizedCode);
                }
            }

            SetActiveSession(existing);
            await TryConnectVoiceAsync();
        }

        public static string NormalizeRoomCode(string roomCode)
        {
            if (string.IsNullOrWhiteSpace(roomCode))
            {
                throw new ArgumentException("A room code is required.", nameof(roomCode));
            }

            return roomCode.Trim().ToUpperInvariant();
        }

        public static string BuildDeviceProfile(string deviceIdentifier)
        {
            string source = string.IsNullOrWhiteSpace(deviceIdentifier)
                ? "virtual-makerspace-device"
                : deviceIdentifier.Trim();
            using SHA256 sha = SHA256.Create();
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(source));
            var token = new StringBuilder(20);
            for (int index = 0; index < 10; index++)
            {
                token.Append(digest[index].ToString("x2"));
            }

            return "quest-" + token;
        }

        public static bool IsMembershipConflictMessage(string message)
        {
            if (string.IsNullOrWhiteSpace(message))
            {
                return false;
            }

            string normalized = message.ToLowerInvariant();
            return normalized.Contains("already a member") ||
                normalized.Contains("already in a lobby") ||
                normalized.Contains("player is already");
        }

        private static bool IsMembershipConflict(SessionException exception)
        {
            return exception.Error == SessionError.LobbyAlreadyExists ||
                IsMembershipConflictMessage(exception.Message);
        }

        private static async Task EnsureServicesAsync()
        {
            await UnityServices.InitializeAsync();
            IAuthenticationService authentication = AuthenticationService.Instance;
            string acceptanceProfile = Environment.GetEnvironmentVariable("VM_AUTH_PROFILE");
            string deviceProfile = BuildDeviceProfile(string.IsNullOrWhiteSpace(acceptanceProfile)
                ? SystemInfo.deviceUniqueIdentifier
                : acceptanceProfile);
            if (authentication.IsSignedIn &&
                !string.Equals(authentication.Profile, deviceProfile, StringComparison.Ordinal))
            {
                authentication.SignOut();
            }

            if (!authentication.IsSignedIn)
            {
                if (!string.Equals(authentication.Profile, deviceProfile, StringComparison.Ordinal))
                {
                    authentication.SwitchProfile(deviceProfile);
                }

                await authentication.SignInAnonymouslyAsync();
            }
        }

        private async Task<ISession> ReuseTargetOrLeaveExistingAsync(string targetCode)
        {
            IMultiplayerService multiplayer = MultiplayerService.Instance;
            var visitedIds = new HashSet<string>();

            foreach (ISession session in multiplayer.Sessions.Values.ToArray())
            {
                visitedIds.Add(session.Id);
                if (MatchesTarget(session, targetCode))
                {
                    return session;
                }

                await LeaveSafelyAsync(session);
            }

            List<string> joinedSessionIds = await multiplayer.GetJoinedSessionIdsAsync();
            foreach (string sessionId in joinedSessionIds)
            {
                if (visitedIds.Contains(sessionId))
                {
                    continue;
                }

                ISession session;
                try
                {
                    session = await multiplayer.ReconnectToSessionAsync(sessionId);
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"Could not reconnect stale session {sessionId}: {exception.GetBaseException().Message}");
                    continue;
                }

                if (MatchesTarget(session, targetCode))
                {
                    return session;
                }

                await LeaveSafelyAsync(session);
            }

            return null;
        }

        private static bool MatchesTarget(ISession session, string targetCode)
        {
            return !string.IsNullOrEmpty(targetCode) &&
                string.Equals(session.Code, targetCode, StringComparison.OrdinalIgnoreCase);
        }

        private static async Task LeaveSafelyAsync(ISession session)
        {
            try
            {
                await session.LeaveAsync();
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Could not leave prior room {session.Code}: {exception.GetBaseException().Message}");
            }
        }

        private void SetActiveSession(ISession session)
        {
            if (activeSession != null)
            {
                activeSession.Changed -= HandleSessionChanged;
                activeSession.StateChanged -= HandleSessionStateChanged;
            }

            activeSession = session;
            activeSession.Changed += HandleSessionChanged;
            activeSession.StateChanged += HandleSessionStateChanged;
            RoomCode = activeSession.Code;
            IsConnected = activeSession.State == SessionState.Connected;
            ParticipantCountChanged?.Invoke(activeSession.PlayerCount);
            Debug.Log($"VM_ACCEPTANCE SESSION_CONNECTED room={RoomCode} participants={activeSession.PlayerCount} state={activeSession.State}");
        }

        private async Task TryConnectVoiceAsync()
        {
            VoiceWarning = string.Empty;
            if (voice == null)
            {
                VoiceWarning = "Voice service is not configured.";
                return;
            }

            try
            {
                await voice.ConnectAsync(RoomCode);
            }
            catch (Exception exception)
            {
                VoiceWarning = exception.GetBaseException().Message;
                Debug.LogWarning($"Room connected without voice: {VoiceWarning}");
            }
        }

        private void HandleSessionChanged()
        {
            ParticipantCountChanged?.Invoke(ParticipantCount);
            Debug.Log($"VM_ACCEPTANCE PARTICIPANTS room={RoomCode} count={ParticipantCount}");
        }

        private void HandleSessionStateChanged(SessionState state)
        {
            IsConnected = state == SessionState.Connected;
            ParticipantCountChanged?.Invoke(ParticipantCount);
            Debug.Log($"VM_ACCEPTANCE SESSION_STATE room={RoomCode} state={state} participants={ParticipantCount}");
        }

        private void OnDestroy()
        {
            if (activeSession == null)
            {
                return;
            }

            activeSession.Changed -= HandleSessionChanged;
            activeSession.StateChanged -= HandleSessionStateChanged;
        }
    }
}
