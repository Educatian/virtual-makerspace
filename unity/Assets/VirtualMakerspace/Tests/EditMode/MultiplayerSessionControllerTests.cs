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
    }
}