using System;
using NUnit.Framework;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Tests
{
    public sealed class VoiceChannelControllerTests
    {
        [Test]
        public void BuildChannelName_NormalizesRoomCode_WhenUsersEnterMixedCaseAndSpaces()
        {
            // Given
            const string roomCode = "  OK-AL-42  ";

            // When
            string channelName = VoiceChannelController.BuildChannelName(roomCode);

            // Then
            Assert.That(channelName, Is.EqualTo("makerspace-ok-al-42"));
        }

        [Test]
        public void BuildChannelName_Throws_WhenRoomCodeIsBlank()
        {
            // Given
            const string roomCode = "   ";

            // When / Then
            Assert.Throws<ArgumentException>(() => VoiceChannelController.BuildChannelName(roomCode));
        }
    }
}