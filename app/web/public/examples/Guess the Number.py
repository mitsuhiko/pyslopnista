import random

secret = random.randint(1, 100)
print("I'm thinking of a number between 1 and 100.")

tries = 0
while True:
    guess = int(input("Your guess: "))
    tries += 1
    if guess < secret:
        print("Higher!")
    elif guess > secret:
        print("Lower!")
    else:
        print(f"Correct! You needed {tries} tries.")
        break
