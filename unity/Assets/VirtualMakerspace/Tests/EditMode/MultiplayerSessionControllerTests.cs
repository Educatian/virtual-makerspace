using System;
using NUnit.Framework;
using VirtualMakerspace.Sessions;

namespace VirtualMakerspace.Tests
{
    public sealed class MultiplayerSessionControllerTests
    {
        [Test]
        public void NormalizeRoomCode_ReturnsCanonicalCode_WhenInputHasSpacesAndLowercase()
        {
            // Given
            const string input = "  ab12cd  ";

            // When
            string result = MultiplayerSessionController.NormalizeRoomCode(input);

            // Then
            Assert.That(result, Is.EqualTo("AB12CD"));
        }

        [Test]
        public void NormalizeRoomCode_Throws_WhenInputIsBlank()
        {
            // Given
            const string input = " ";

            // When / Then
            Assert.Throws<ArgumentException>(() => MultiplayerSessionController.NormalizeRoomCode(input));
        }

        [Test]
        public void BuildDeviceProfile_IsStableValidAndDeviceSpecific()
        {
            string first = MultiplayerSessionController.BuildDeviceProfile("quest-device-a");
            string repeated = MultiplayerSessionController.BuildDeviceProfile("quest-device-a");
            string second = MultiplayerSessionController.BuildDeviceProfile("quest-device-b");

            Assert.That(first, Is.EqualTo(repeated));
            Assert.That(first, Is.Not.EqualTo(second));
            Assert.That(first.Length, Is.LessThanOrEqualTo(30));
            StringAssert.IsMatch("^[A-Za-z0-9_-]+$", first);
        }

        [TestCase("PLAYER IS ALREADY A MEMBER OF THE LOBBY")]
        [TestCase("Player is already in a lobby")]
        [TestCase("player is already subscribed")]
        public void MembershipConflictMessage_RecognizesBackendVariants(string message)
        {
            Assert.That(MultiplayerSessionController.IsMembershipConflictMessage(message), Is.True);
        }

        [TestCase("")]
        [TestCase("The room code was not found")]
        [TestCase("Network request timed out")]
        public void MembershipConflictMessage_DoesNotMaskUnrelatedFailures(string message)
        {
            Assert.That(MultiplayerSessionController.IsMembershipConflictMessage(message), Is.False);
        }
    }
}
